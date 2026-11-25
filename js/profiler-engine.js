// Dual-Engine Profiler: Live Zero-PMC ETW (On-CPU + Off-CPU) & AMDuProfCLI Hardware-Stall/IBS Burst Engine
(() => {
  'use strict';
  const Z = window.Zen2Top || (window.Zen2Top = {});
  const { SymbolResolver, parseRva, fmtHexRva } = Z;

  const ETW_KERNEL_FLAGS = Object.freeze({
    EVENT_TRACE_FLAG_PROFILE: 0x01000000,
    EVENT_TRACE_FLAG_CSWITCH: 0x00000010,
    EVENT_TRACE_FLAG_DISPATCHER: 0x00000800, // ReadyThread event type 0x32
    EVENT_TRACE_FLAG_IMAGE_LOAD: 0x00000004
  });

  const BURST_PROFILES = Object.freeze([
    {
      id: 'ibs_op',
      hotkey: '1',
      label: 'IBS Op Load Latency',
      shortLabel: 'IBS Op',
      desc: 'DRAM / L3 / L2 data source + measured load-latency cycles',
      metricUnit: 'cyc',
      primaryArgs: (pid, sec, tmpDir) =>
        `AMDuProfCLI.exe collect --config ibs -p ${pid} -d ${sec} -g -o "${tmpDir}"`,
      fallbackArgs: (pid, sec, tmpDir) =>
        `AMDuProfCLI.exe collect -e event=ibs-op,interval=100000,loadstore -p ${pid} -d ${sec} -g -o "${tmpDir}"`
    },
    {
      id: 'dram_l3',
      hotkey: '2',
      label: 'DRAM / L3 Miss Hotspots',
      shortLabel: 'DRAM/L3',
      desc: 'D-Cache demand DRAM fills (0x43 umask 0x08, interval 25k)',
      metricUnit: 'samples',
      primaryArgs: (pid, sec, tmpDir) =>
        `AMDuProfCLI.exe collect -e event=0x43,umask=0x08,interval=25000 -p ${pid} -d ${sec} -g -o "${tmpDir}"`,
      fallbackArgs: (pid, sec, tmpDir) =>
        `AMDuProfCLI.exe collect -e event=ibsop-l3miss,interval=25000 -p ${pid} -d ${sec} -g -o "${tmpDir}"`
    },
    {
      id: 'branch_miss',
      hotkey: '3',
      label: 'Branch Mispredict Hotspots',
      shortLabel: 'Branch',
      desc: 'Retired branch mispredictions (0xC3 umask 0x00, interval 50k)',
      metricUnit: 'samples',
      primaryArgs: (pid, sec, tmpDir) =>
        `AMDuProfCLI.exe collect -e event=0xC3,umask=0x00,interval=50000 -p ${pid} -d ${sec} -g -o "${tmpDir}"`,
      fallbackArgs: null
    },
    {
      id: 'tlb_walk',
      hotkey: '4',
      label: 'L2 iTLB / dTLB Walk Hotspots',
      shortLabel: 'L2 TLB',
      desc: 'L2 iTLB (0x85/0x07) & L2 dTLB (0x45/0xF0) page walks (interval 10k)',
      metricUnit: 'samples',
      primaryArgs: (pid, sec, tmpDir) =>
        `AMDuProfCLI.exe collect -e event=0x85,umask=0x07,interval=10000 -e event=0x45,umask=0xF0,interval=10000 -p ${pid} -d ${sec} -g -o "${tmpDir}"`,
      fallbackArgs: null
    }
  ]);

  function getBurstProfile(id) {
    return BURST_PROFILES.find(b => b.id === id) || BURST_PROFILES[0];
  }

  function buildUprofReportCommand(sessionDir, reportCsv) {
    return `AMDuProfCLI.exe report -i "${sessionDir}" --detail -g --report-output "${reportCsv}"`;
  }

  function locateUprofCli(opts = {}) {
    if (opts.available === false) {
      return {
        found: false,
        path: null,
        error: 'AMDuProfCLI.exe not found in PATH or C:\\Program Files\\AMD\\AMDuProf\\bin\\AMDuProfCLI.exe. Install AMD uProf alongside AMDuProfPcm.exe to enable hardware-stall burst capture.'
      };
    }
    return {
      found: true,
      path: opts.customPath || 'C:\\Program Files\\AMD\\AMDuProf\\bin\\AMDuProfCLI.exe',
      error: null
    };
  }

  // =========================================================================
  // CALL-TREE & FLAT HOTSPOT AGGREGATOR (Bounded LRU/Cap, Recursion-Safe)
  // =========================================================================
  class CallTreeAggregator {
    constructor(opts = {}) {
      this.maxNodes = Math.max(16, opts.maxNodes || 20000);
      this.reset();
    }

    reset() {
      this.totalSamples = 0;
      this.nodeCount = 0;
      this.evictedNodes = 0;
      this.tickSeq = 0;
      this.flatMap = new Map(); // fnKey -> stats
      this.rootChildren = new Map(); // fnKey -> TreeNode
      this.threadBuckets = new Map(); // tid -> { totalSamples, flatMap, rootChildren }
      this.allTreeNodes = new Map(); // nodeId -> node (for LRU cap)
    }

    _makeFlatEntry(frame) {
      return {
        key: frame.key,
        module: frame.module,
        name: frame.name,
        displayName: frame.displayName || frame.name,
        signature: frame.signature || frame.name,
        tier: frame.tier || '.pdata',
        fileLine: frame.fileLine || null,
        rva: frame.rva || 0,
        fnStartRva: frame.fnStartRva ?? (frame.rva || 0),
        fnEndRva: frame.fnEndRva ?? ((frame.rva || 0) + 1),
        selfSamples: 0,
        inclusiveSamples: 0,
        latencyWeightedSum: 0,
        latencyCount: 0,
        dataSourceCounts: {},
        callers: new Map(), // callerKey -> { name, module, count }
        callees: new Map()  // calleeKey -> { name, module, count }
      };
    }

    _makeTreeNode(id, frame, parent) {
      return {
        id,
        key: frame.key,
        module: frame.module,
        name: frame.name,
        displayName: frame.displayName || frame.name,
        signature: frame.signature || frame.name,
        tier: frame.tier || '.pdata',
        fileLine: frame.fileLine || null,
        rva: frame.rva || 0,
        fnStartRva: frame.fnStartRva ?? (frame.rva || 0),
        fnEndRva: frame.fnEndRva ?? ((frame.rva || 0) + 1),
        selfSamples: 0,
        inclusiveSamples: 0,
        latencyWeightedSum: 0,
        latencyCount: 0,
        dataSourceCounts: {},
        parent,
        children: new Map(),
        lastTouch: ++this.tickSeq
      };
    }

    _enforceNodeCap() {
      while (this.nodeCount > this.maxNodes && this.allTreeNodes.size > 0) {
        // Evict least-recently-touched leaf node with smallest inclusiveSamples
        let victim = null;
        for (const node of this.allTreeNodes.values()) {
          if (node.children.size > 0) continue;
          if (!victim || node.lastTouch < victim.lastTouch) {
            victim = node;
          }
        }
        if (!victim) break;
        this.allTreeNodes.delete(victim.id);
        if (victim.parent) {
          victim.parent.children.delete(victim.key);
        } else {
          this.rootChildren.delete(victim.key);
        }
        this.nodeCount = Math.max(0, this.nodeCount - 1);
        this.evictedNodes += 1;
      }
    }

    // stackFrames: array ordered ROOT -> ... -> LEAF (entry point first, active RIP last)
    // opts: { tid, weight, latencyCyc, dataSource, leafFirst }
    recordSample(stackFrames, opts = {}) {
      if (!Array.isArray(stackFrames) || stackFrames.length === 0) return;
      const weight = Math.max(1, Number(opts.weight) || 1);
      const frames = opts.leafFirst ? [...stackFrames].reverse() : stackFrames;
      const tid = opts.tid ?? null;
      const latencyCyc = Number.isFinite(opts.latencyCyc) ? opts.latencyCyc : null;
      const dataSource = opts.dataSource || null;

      this.totalSamples += weight;
      this._applyToBucket(this.flatMap, this.rootChildren, frames, weight, latencyCyc, dataSource, true);

      if (tid !== null && tid !== undefined) {
        let tb = this.threadBuckets.get(tid);
        if (!tb) {
          tb = { totalSamples: 0, flatMap: new Map(), rootChildren: new Map() };
          this.threadBuckets.set(tid, tb);
        }
        tb.totalSamples += weight;
        this._applyToBucket(tb.flatMap, tb.rootChildren, frames, weight, latencyCyc, dataSource, false);
      }
    }

    _applyToBucket(flatMap, rootChildren, frames, weight, latencyCyc, dataSource, trackGlobalCap) {
      const seenInclusive = new Set();
      const leafIdx = frames.length - 1;

      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        let entry = flatMap.get(f.key);
        if (!entry) {
          entry = this._makeFlatEntry(f);
          flatMap.set(f.key, entry);
        } else {
          // Refresh resolved metadata (e.g. if sidecar map loaded)
          entry.name = f.name;
          entry.displayName = f.displayName || f.name;
          entry.signature = f.signature || f.name;
          entry.tier = f.tier || entry.tier;
          if (f.fileLine) entry.fileLine = f.fileLine;
        }

        // Deduplicate recursive frames so inclusiveSamples is never > totalSamples
        if (!seenInclusive.has(f.key)) {
          seenInclusive.add(f.key);
          entry.inclusiveSamples += weight;
        }

        if (i === leafIdx) {
          entry.selfSamples += weight;
          if (latencyCyc !== null) {
            entry.latencyWeightedSum += latencyCyc * weight;
            entry.latencyCount += weight;
          }
          if (dataSource) {
            entry.dataSourceCounts[dataSource] = (entry.dataSourceCounts[dataSource] || 0) + weight;
          }
        }

        // Caller / callee edges (skip direct self-recursion edge noise or keep cleanly)
        if (i > 0) {
          const caller = frames[i - 1];
          const cObj = entry.callers.get(caller.key) || { key: caller.key, name: caller.displayName || caller.name, module: caller.module, count: 0 };
          cObj.count += weight;
          entry.callers.set(caller.key, cObj);
        }
        if (i < leafIdx) {
          const callee = frames[i + 1];
          const ceObj = entry.callees.get(callee.key) || { key: callee.key, name: callee.displayName || callee.name, module: callee.module, count: 0 };
          ceObj.count += weight;
          entry.callees.set(callee.key, ceObj);
        }
      }

      // Walk/update hierarchical call tree (root -> leaf)
      let currentMap = rootChildren;
      let parentNode = null;
      let pathId = '';
      // Avoid double-counting inclusive on recursive ancestor nodes in the tree path
      const seenTreeKeys = new Set();

      for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        pathId = pathId ? `${pathId}>${f.key}` : f.key;
        let node = currentMap.get(f.key);
        if (!node) {
          node = this._makeTreeNode(pathId, f, parentNode);
          currentMap.set(f.key, node);
          if (trackGlobalCap) {
            this.nodeCount += 1;
            this.allTreeNodes.set(pathId, node);
          }
        } else {
          node.lastTouch = ++this.tickSeq;
        }
        if (!seenTreeKeys.has(f.key)) {
          seenTreeKeys.add(f.key);
          node.inclusiveSamples += weight;
        }
        if (i === leafIdx) {
          node.selfSamples += weight;
          if (latencyCyc !== null) {
            node.latencyWeightedSum += latencyCyc * weight;
            node.latencyCount += weight;
          }
          if (dataSource) {
            node.dataSourceCounts[dataSource] = (node.dataSourceCounts[dataSource] || 0) + weight;
          }
        }
        parentNode = node;
        currentMap = node.children;
      }

      if (trackGlobalCap && this.nodeCount > this.maxNodes) {
        this._enforceNodeCap();
      }
    }

    _topSource(counts) {
      let best = null;
      let bestN = 0;
      for (const [k, v] of Object.entries(counts || {})) {
        if (v > bestN) {
          bestN = v;
          best = k;
        }
      }
      return best;
    }

    getFlatHotspots(opts = {}) {
      const tid = opts.tid ?? null;
      const filter = String(opts.filter || '').trim().toLowerCase();
      const bucket = (tid !== null && tid !== undefined)
        ? this.threadBuckets.get(tid)
        : { totalSamples: this.totalSamples, flatMap: this.flatMap };
      if (!bucket || bucket.totalSamples <= 0) return [];

      const total = bucket.totalSamples;
      const rows = [];
      for (const e of bucket.flatMap.values()) {
        if (filter) {
          const hay = `${e.module} ${e.name} ${e.displayName} ${e.signature} ${e.fileLine || ''}`.toLowerCase();
          if (!hay.includes(filter)) continue;
        }
        const callers = [...e.callers.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 2)
          .map(c => ({ ...c, pct: (c.count / Math.max(1, e.inclusiveSamples)) * 100.0 }));
        const callees = [...e.callees.values()]
          .sort((a, b) => b.count - a.count)
          .slice(0, 2)
          .map(c => ({ ...c, pct: (c.count / Math.max(1, e.inclusiveSamples)) * 100.0 }));
        rows.push({
          id: e.key,
          key: e.key,
          module: e.module,
          name: e.name,
          displayName: e.displayName,
          signature: e.signature,
          tier: e.tier,
          fileLine: e.fileLine,
          rva: e.rva,
          fnStartRva: e.fnStartRva,
          fnEndRva: e.fnEndRva,
          selfSamples: e.selfSamples,
          selfPct: (e.selfSamples / total) * 100.0,
          inclusiveSamples: e.inclusiveSamples,
          inclusivePct: Math.min(100.0, (e.inclusiveSamples / total) * 100.0),
          avgLatencyCyc: e.latencyCount > 0 ? e.latencyWeightedSum / e.latencyCount : null,
          topDataSource: this._topSource(e.dataSourceCounts),
          callers,
          callees
        });
      }
      rows.sort((a, b) => (b.selfSamples - a.selfSamples) || (b.inclusiveSamples - a.inclusiveSamples));
      return rows;
    }

    getTreeRows(opts = {}) {
      const tid = opts.tid ?? null;
      const filter = String(opts.filter || '').trim().toLowerCase();
      const expandedIds = opts.expandedIds || new Set();
      const bucket = (tid !== null && tid !== undefined)
        ? this.threadBuckets.get(tid)
        : { totalSamples: this.totalSamples, flatMap: this.flatMap, rootChildren: this.rootChildren };
      if (!bucket || bucket.totalSamples <= 0) return [];

      const total = bucket.totalSamples;
      const out = [];

      const matchesFilter = (node) => {
        if (!filter) return true;
        const hay = `${node.module} ${node.name} ${node.displayName} ${node.signature}`.toLowerCase();
        if (hay.includes(filter)) return true;
        for (const ch of node.children.values()) {
          if (matchesFilter(ch)) return true;
        }
        return false;
      };

      const walk = (childrenMap, depth, prefixParts) => {
        const list = [...childrenMap.values()]
          .filter(matchesFilter)
          .sort((a, b) => (b.inclusiveSamples - a.inclusiveSamples) || (b.selfSamples - a.selfSamples));

        list.forEach((node, idx) => {
          const isLast = idx === list.length - 1;
          const hasChildren = node.children.size > 0;
          const isExpanded = Boolean(filter) || expandedIds.has(node.id);
          const flatRef = bucket.flatMap.get(node.key);
          const callers = flatRef
            ? [...flatRef.callers.values()].sort((a, b) => b.count - a.count).slice(0, 2)
                .map(c => ({ ...c, pct: (c.count / Math.max(1, flatRef.inclusiveSamples)) * 100.0 }))
            : [];
          const callees = flatRef
            ? [...flatRef.callees.values()].sort((a, b) => b.count - a.count).slice(0, 2)
                .map(c => ({ ...c, pct: (c.count / Math.max(1, flatRef.inclusiveSamples)) * 100.0 }))
            : [];

          let treePrefix = '';
          if (depth > 0) {
            treePrefix = prefixParts.join('') + (isLast ? '└─ ' : '├─ ');
          }

          out.push({
            id: node.id,
            key: node.key,
            depth,
            treePrefix,
            hasChildren,
            isExpanded,
            module: node.module,
            name: node.name,
            displayName: node.displayName,
            signature: node.signature,
            tier: node.tier,
            fileLine: node.fileLine,
            rva: node.rva,
            fnStartRva: node.fnStartRva,
            fnEndRva: node.fnEndRva,
            selfSamples: node.selfSamples,
            selfPct: (node.selfSamples / total) * 100.0,
            inclusiveSamples: node.inclusiveSamples,
            inclusivePct: Math.min(100.0, (node.inclusiveSamples / total) * 100.0),
            avgLatencyCyc: node.latencyCount > 0 ? node.latencyWeightedSum / node.latencyCount : null,
            topDataSource: this._topSource(node.dataSourceCounts),
            callers,
            callees
          });

          if (hasChildren && isExpanded) {
            const nextParts = depth === 0 ? [] : [...prefixParts, isLast ? '   ' : '│  '];
            walk(node.children, depth + 1, nextParts);
          }
        });
      };

      walk(bucket.rootChildren, 0, []);
      return out;
    }

    getTotalSamples(tid = null) {
      if (tid !== null && tid !== undefined) {
        const tb = this.threadBuckets.get(tid);
        return tb ? tb.totalSamples : 0;
      }
      return this.totalSamples;
    }
  }

  // =========================================================================
  // OFF-CPU / WAIT-CHAIN AGGREGATOR (CSwitch + ReadyThread Pairing)
  // =========================================================================
  class OffCpuAggregator {
    constructor(opts = {}) {
      this.targetPid = opts.targetPid ?? null;
      this.reset();
    }

    reset(targetPid = this.targetPid) {
      this.targetPid = targetPid;
      this.pendingOut = new Map(); // tid -> { outTsUs, stack, waker }
      this.totalBlockedUs = 0;
      this.totalWakes = 0;
      this.groups = new Map(); // groupKey -> wait group
      this.threadGroups = new Map(); // tid -> { totalBlockedUs, totalWakes, groups: Map }
    }

    // CSwitch switch-out: target thread leaves CPU
    onCSwitchOut(ev) {
      if (!ev) return;
      if (this.targetPid !== null && ev.pid !== this.targetPid) return;
      this.pendingOut.set(ev.tid, {
        pid: ev.pid,
        tid: ev.tid,
        threadName: ev.threadName || `TID ${ev.tid}`,
        outTsUs: ev.tsUs,
        stack: Array.isArray(ev.stack) ? ev.stack : [],
        waker: null
      });
    }

    // ReadyThread (event type 0x32): waker unblocks sleeping target thread
    onReadyThread(ev) {
      if (!ev) return;
      if (this.targetPid !== null && ev.targetPid !== this.targetPid) return;
      const pending = this.pendingOut.get(ev.targetTid);
      if (!pending) return;
      pending.waker = {
        wakerPid: ev.wakerPid,
        wakerTid: ev.wakerTid,
        wakerName: ev.wakerName || `TID ${ev.wakerTid}`,
        readyTsUs: ev.tsUs
      };
    }

    // CSwitch switch-in: target thread resumes CPU -> commit paired wait interval
    onCSwitchIn(ev) {
      if (!ev) return null;
      if (this.targetPid !== null && ev.pid !== this.targetPid) return null;
      const pending = this.pendingOut.get(ev.tid);
      if (!pending) return null;
      this.pendingOut.delete(ev.tid);

      const durationUs = Math.max(0, (ev.tsUs || 0) - (pending.outTsUs || 0));
      if (durationUs <= 0) return null;

      const stack = pending.stack;
      const leaf = stack[stack.length - 1] || {
        key: 'ntdll.dll!WaitForSingleObject',
        module: 'ntdll.dll',
        name: 'WaitForSingleObject',
        displayName: 'WaitForSingleObject',
        signature: 'ntdll.dll!WaitForSingleObject',
        tier: 'EXP',
        rva: 0x9C410,
        fnStartRva: 0x9C410,
        fnEndRva: 0x9C490,
        fileLine: null
      };
      const caller = stack.length >= 2 ? stack[stack.length - 2] : null;
      const wakerLabel = pending.waker ? pending.waker.wakerName : 'Kernel/Timer';
      const groupKey = `${leaf.key}|${caller ? caller.key : ''}`;

      this.totalBlockedUs += durationUs;
      this.totalWakes += 1;
      this._addToGroupMap(this.groups, groupKey, leaf, caller, stack, pending.threadName, wakerLabel, durationUs);

      let tb = this.threadGroups.get(ev.tid);
      if (!tb) {
        tb = { totalBlockedUs: 0, totalWakes: 0, groups: new Map() };
        this.threadGroups.set(ev.tid, tb);
      }
      tb.totalBlockedUs += durationUs;
      tb.totalWakes += 1;
      this._addToGroupMap(tb.groups, groupKey, leaf, caller, stack, pending.threadName, wakerLabel, durationUs);

      return { tid: ev.tid, durationUs, waker: pending.waker, leaf };
    }

    _addToGroupMap(map, groupKey, leaf, caller, stack, threadName, wakerLabel, durationUs) {
      let g = map.get(groupKey);
      if (!g) {
        g = {
          id: groupKey,
          key: leaf.key,
          module: leaf.module,
          name: leaf.name,
          displayName: leaf.displayName || leaf.name,
          signature: leaf.signature || leaf.name,
          tier: leaf.tier || 'EXP',
          fileLine: leaf.fileLine || null,
          rva: leaf.rva || 0,
          fnStartRva: leaf.fnStartRva ?? (leaf.rva || 0),
          fnEndRva: leaf.fnEndRva ?? ((leaf.rva || 0) + 1),
          callerName: caller ? (caller.displayName || caller.name) : null,
          callerModule: caller ? caller.module : null,
          stackSummary: stack.map(s => s.displayName || s.name).join(' -> '),
          blockedUs: 0,
          wakes: 0,
          wakers: new Map(),
          waiters: new Map()
        };
        map.set(groupKey, g);
      }
      g.blockedUs += durationUs;
      g.wakes += 1;
      g.wakers.set(wakerLabel, (g.wakers.get(wakerLabel) || 0) + 1);
      g.waiters.set(threadName, (g.waiters.get(threadName) || 0) + durationUs);
    }

    getWaitRows(opts = {}) {
      const tid = opts.tid ?? null;
      const filter = String(opts.filter || '').trim().toLowerCase();
      const bucket = (tid !== null && tid !== undefined)
        ? this.threadGroups.get(tid)
        : { totalBlockedUs: this.totalBlockedUs, totalWakes: this.totalWakes, groups: this.groups };
      if (!bucket || bucket.totalBlockedUs <= 0) return [];

      const totalUs = bucket.totalBlockedUs;
      const rows = [];
      for (const g of bucket.groups.values()) {
        const wakersSorted = [...g.wakers.entries()].sort((a, b) => b[1] - a[1]);
        const topWakerEntry = wakersSorted[0] || ['Kernel/Timer', g.wakes];
        const topWakerName = topWakerEntry[0];
        const topWakerPct = (topWakerEntry[1] / Math.max(1, g.wakes)) * 100.0;

        const waitersSorted = [...g.waiters.entries()].sort((a, b) => b[1] - a[1]);
        const topWaiterName = waitersSorted[0] ? waitersSorted[0][0] : 'Thread';

        const displayStack = g.callerName
          ? `${g.displayName} <- ${g.callerName}`
          : g.displayName;

        if (filter) {
          const hay = `${g.module} ${g.name} ${displayStack} ${topWakerName} ${topWaiterName}`.toLowerCase();
          if (!hay.includes(filter)) continue;
        }

        rows.push({
          id: g.id,
          key: g.key,
          module: g.module,
          name: g.name,
          displayName: g.displayName,
          displayStack,
          stackSummary: g.stackSummary,
          signature: g.signature,
          tier: g.tier,
          fileLine: g.fileLine,
          rva: g.rva,
          fnStartRva: g.fnStartRva,
          fnEndRva: g.fnEndRva,
          blockedMs: g.blockedUs / 1000.0,
          blockedPct: (g.blockedUs / totalUs) * 100.0,
          avgWaitMs: (g.blockedUs / Math.max(1, g.wakes)) / 1000.0,
          wakes: g.wakes,
          topWakerName,
          topWakerPct,
          topWaiterName,
          callers: g.callerName ? [{ name: g.callerName, module: g.callerModule, pct: 100.0 }] : [],
          callees: []
        });
      }
      rows.sort((a, b) => b.blockedMs - a.blockedMs);
      return rows;
    }

    getTotalWakes(tid = null) {
      if (tid !== null && tid !== undefined) {
        const tb = this.threadGroups.get(tid);
        return tb ? tb.totalWakes : 0;
      }
      return this.totalWakes;
    }
  }

  // =========================================================================
  // AMDuProfCLI report.csv PARSER (Flat + Call-Graph + IBS Load Latency)
  // =========================================================================
  function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  }

  function parseUprofBurstReportCsv(csvText, resolver = null, burstMeta = {}) {
    const lines = String(csvText || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const agg = new CallTreeAggregator({ maxNodes: 20000 });
    const parsedRows = [];

    let headerIdx = -1;
    let headers = [];
    for (let i = 0; i < lines.length; i++) {
      const low = lines[i].toLowerCase();
      if (low.includes('function') && low.includes('module') && (low.includes('self') || low.includes('samples'))) {
        headerIdx = i;
        headers = parseCsvLine(lines[i]).map(h => h.toLowerCase());
        break;
      }
    }
    if (headerIdx === -1) {
      return {
        burstType: burstMeta.burstType || 'ibs_op',
        capturedAt: burstMeta.capturedAt || '--:--:--',
        durationSec: burstMeta.durationSec || 5,
        aggregator: agg,
        totalSamples: 0,
        flatRows: [],
        parsedRows
      };
    }

    const colIdx = (patterns) => headers.findIndex(h => patterns.some(p => h.includes(p)));
    const iFunc = colIdx(['function', 'symbol']);
    const iMod = colIdx(['module', 'image']);
    const iRva = colIdx(['rva', 'offset', 'address']);
    const iSelf = colIdx(['self samples', 'self', 'samples']);
    const iIncl = colIdx(['inclusive samples', 'inclusive', 'total samples']);
    const iLat = colIdx(['avg load latency', 'latency', 'lat (cyc)', 'ibs lat']);
    const iSrc = colIdx(['data source', 'source', 'mem src']);
    const iCallers = colIdx(['callers', 'call stack', 'callstack', 'parent']);
    const iTid = colIdx(['tid', 'thread']);

    const resolveFrame = (modName, fnName, rvaVal) => {
      if (resolver) {
        return resolver.enrichCsvSymbol(modName, fnName, rvaVal);
      }
      const rva = parseRva(rvaVal);
      return {
        module: modName || 'unknown',
        name: fnName || `${modName}!${fmtHexRva(rva)}`,
        displayName: fnName || fmtHexRva(rva),
        signature: `${modName}!${fnName || fmtHexRva(rva)}`,
        tier: fnName && !fnName.startsWith('0x') ? 'PDB' : '.pdata',
        fileLine: null,
        rva: Number.isFinite(rva) ? rva : 0,
        fnStartRva: Number.isFinite(rva) ? rva : 0,
        fnEndRva: Number.isFinite(rva) ? rva + 0x100 : 0,
        key: `${String(modName || 'unknown').toLowerCase()}!${fnName || fmtHexRva(rva)}`
      };
    };

    for (let i = headerIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#') || line.startsWith('---')) continue;
      const cols = parseCsvLine(line);
      if (cols.length < 3) continue;

      const rawFunc = iFunc >= 0 ? cols[iFunc] : '';
      const rawMod = iMod >= 0 ? cols[iMod] : 'unknown';
      if (!rawFunc && !rawMod) continue;

      const rvaVal = iRva >= 0 ? parseRva(cols[iRva]) : NaN;
      const selfSamples = iSelf >= 0 ? Math.max(0, Math.round(Number(cols[iSelf]) || 0)) : 0;
      const inclSamples = iIncl >= 0 ? Math.max(selfSamples, Math.round(Number(cols[iIncl]) || 0)) : selfSamples;
      const latRaw = iLat >= 0 ? Number(cols[iLat]) : NaN;
      const latencyCyc = Number.isFinite(latRaw) && latRaw > 0 ? latRaw : null;
      const dataSource = iSrc >= 0 && cols[iSrc] ? cols[iSrc] : null;
      const tidRaw = iTid >= 0 ? Number(cols[iTid]) : NaN;
      const tid = Number.isFinite(tidRaw) ? tidRaw : null;

      const leafFrame = resolveFrame(rawMod, rawFunc, rvaVal);

      // Parse optional call-graph chain (Root > Mid > Leaf or Parent1;Parent2)
      const chainRaw = iCallers >= 0 ? (cols[iCallers] || '') : '';
      const stackFrames = [];
      if (chainRaw) {
        const parts = chainRaw.split('>').map(s => s.trim()).filter(Boolean);
        for (const p of parts) {
          const bang = p.indexOf('!');
          let pMod = rawMod;
          let pFn = p;
          let pRva = NaN;
          if (bang > 0) {
            pMod = p.slice(0, bang).trim();
            pFn = p.slice(bang + 1).trim();
          }
          const atIdx = pFn.indexOf('@');
          if (atIdx > 0) {
            pRva = parseRva(pFn.slice(atIdx + 1));
            pFn = pFn.slice(0, atIdx).trim();
          }
          stackFrames.push(resolveFrame(pMod, pFn, pRva));
        }
      }
      stackFrames.push(leafFrame);

      if (selfSamples > 0) {
        agg.recordSample(stackFrames, {
          tid,
          weight: selfSamples,
          latencyCyc,
          dataSource
        });
      }

      parsedRows.push({
        module: leafFrame.module,
        name: leafFrame.name,
        displayName: leafFrame.displayName,
        tier: leafFrame.tier,
        rva: leafFrame.rva,
        selfSamples,
        inclusiveSamples: inclSamples,
        avgLatencyCyc: latencyCyc,
        dataSource
      });
    }

    return {
      burstType: burstMeta.burstType || 'ibs_op',
      burstLabel: burstMeta.burstLabel || getBurstProfile(burstMeta.burstType).shortLabel,
      capturedAt: burstMeta.capturedAt || '--:--:--',
      durationSec: burstMeta.durationSec || 5,
      command: burstMeta.command || '',
      aggregator: agg,
      totalSamples: agg.totalSamples,
      flatRows: agg.getFlatHotspots(),
      parsedRows
    };
  }

  // =========================================================================
  // PMU COORDINATOR STATE MACHINE (Pause PCM -> Burst -> Report -> Resume PCM)
  // =========================================================================
  class PmuCoordinator {
    constructor(callbacks = {}) {
      this.state = 'LIVE_PCM'; // LIVE_PCM | PAUSING_PCM | CAPTURING_BURST | GENERATING_REPORT | RESUMING_PCM
      this.pcmRunning = true;
      this.history = [];
      this.activeBurst = null;
      this.callbacks = {
        pausePcm: callbacks.pausePcm || (() => {}),
        resumePcm: callbacks.resumePcm || (() => {}),
        collectBurst: callbacks.collectBurst || (() => ''),
        cleanupTmpDir: callbacks.cleanupTmpDir || (() => {}),
        onStateChange: callbacks.onStateChange || (() => {})
      };
    }

    _transition(nextState, info = {}) {
      this.state = nextState;
      this.history.push({ state: nextState, ...info });
      this.callbacks.onStateChange(nextState, info);
    }

    // Synchronous guaranteed-resume burst runner (useful for deterministic sync checks & tests)
    runBurstSync(opts = {}) {
      if (this.state !== 'LIVE_PCM') {
        throw new Error(`PmuCoordinator busy in state ${this.state}`);
      }
      const profile = getBurstProfile(opts.burstType || 'ibs_op');
      const pid = opts.pid;
      const durationSec = opts.durationSec || 5;
      const tmpDir = opts.tmpDir || `C:\\Temp\\zen2top_burst_${pid}_${Date.now()}`;
      const cliCheck = locateUprofCli({ available: opts.cliAvailable !== false });
      if (!cliCheck.found) {
        return { ok: false, error: cliCheck.error, state: this.state, pcmRunning: this.pcmRunning };
      }

      this.activeBurst = { burstType: profile.id, label: profile.shortLabel, durationSec, remainingSec: durationSec, tmpDir };
      let report = null;
      let err = null;

      try {
        this._transition('PAUSING_PCM', { pid, burstType: profile.id });
        this.pcmRunning = false;
        this.callbacks.pausePcm();

        this._transition('CAPTURING_BURST', { pid, burstType: profile.id, durationSec, tmpDir });
        const csvText = this.callbacks.collectBurst({ pid, durationSec, burstType: profile.id, tmpDir, profile });

        this._transition('GENERATING_REPORT', { pid, burstType: profile.id, tmpDir });
        report = parseUprofBurstReportCsv(csvText, opts.resolver || null, {
          burstType: profile.id,
          burstLabel: profile.shortLabel,
          durationSec,
          capturedAt: opts.capturedAt || new Date().toTimeString().slice(0, 8),
          command: profile.primaryArgs(pid, durationSec, tmpDir)
        });
      } catch (e) {
        err = e;
      } finally {
        try {
          this.callbacks.cleanupTmpDir(tmpDir);
        } catch (_) {
          // Best-effort temp cleanup
        }
        this._transition('RESUMING_PCM', { hadError: Boolean(err) });
        this.callbacks.resumePcm();
        this.pcmRunning = true;
        this.activeBurst = null;
        this._transition('LIVE_PCM', { resumed: true });
      }

      if (err) {
        return { ok: false, error: err.message || String(err), report: null, state: this.state, pcmRunning: this.pcmRunning };
      }
      return { ok: true, error: null, report, state: this.state, pcmRunning: this.pcmRunning };
    }

    // Async guaranteed-resume burst runner
    async runBurst(opts = {}) {
      if (this.state !== 'LIVE_PCM') {
        throw new Error(`PmuCoordinator busy in state ${this.state}`);
      }
      const profile = getBurstProfile(opts.burstType || 'ibs_op');
      const pid = opts.pid;
      const durationSec = opts.durationSec || 5;
      const tmpDir = opts.tmpDir || `C:\\Temp\\zen2top_burst_${pid}_${Date.now()}`;
      const cliCheck = locateUprofCli({ available: opts.cliAvailable !== false });
      if (!cliCheck.found) {
        return { ok: false, error: cliCheck.error, state: this.state, pcmRunning: this.pcmRunning };
      }

      this.activeBurst = { burstType: profile.id, label: profile.shortLabel, durationSec, remainingSec: durationSec, tmpDir };
      let report = null;
      let err = null;

      try {
        this._transition('PAUSING_PCM', { pid, burstType: profile.id });
        this.pcmRunning = false;
        await this.callbacks.pausePcm();

        this._transition('CAPTURING_BURST', { pid, burstType: profile.id, durationSec, tmpDir });
        const csvText = await this.callbacks.collectBurst({ pid, durationSec, burstType: profile.id, tmpDir, profile });

        this._transition('GENERATING_REPORT', { pid, burstType: profile.id, tmpDir });
        report = parseUprofBurstReportCsv(csvText, opts.resolver || null, {
          burstType: profile.id,
          burstLabel: profile.shortLabel,
          durationSec,
          capturedAt: opts.capturedAt || new Date().toTimeString().slice(0, 8),
          command: profile.primaryArgs(pid, durationSec, tmpDir)
        });
      } catch (e) {
        err = e;
      } finally {
        try {
          await this.callbacks.cleanupTmpDir(tmpDir);
        } catch (_) {
          // Best-effort temp cleanup
        }
        this._transition('RESUMING_PCM', { hadError: Boolean(err) });
        await this.callbacks.resumePcm();
        this.pcmRunning = true;
        this.activeBurst = null;
        this._transition('LIVE_PCM', { resumed: true });
      }

      if (err) {
        return { ok: false, error: err.message || String(err), report: null, state: this.state, pcmRunning: this.pcmRunning };
      }
      return { ok: true, error: null, report, state: this.state, pcmRunning: this.pcmRunning };
    }
  }

  // =========================================================================
  // LIVE ETW SESSION WRAPPER (Zero-PMC, Safe Cleanup on Exit/Ctrl+C)
  // =========================================================================
  class EtwProfilerSession {
    constructor(opts = {}) {
      this.sessionName = opts.sessionName || 'zen2top_live_etw';
      this.sampleRateKhz = Math.min(4, Math.max(1, opts.sampleRateKhz || 1));
      this.maxNodes = opts.maxNodes || 20000;
      this.enabledFlags =
        ETW_KERNEL_FLAGS.EVENT_TRACE_FLAG_PROFILE |
        ETW_KERNEL_FLAGS.EVENT_TRACE_FLAG_CSWITCH |
        ETW_KERNEL_FLAGS.EVENT_TRACE_FLAG_DISPATCHER |
        ETW_KERNEL_FLAGS.EVENT_TRACE_FLAG_IMAGE_LOAD;
      this.stackWalkEnabled = ['SampledProfile', 'CSwitch', 'ReadyThread'];
      this.running = false;
      this.paused = false;
      this.targetPid = null;
      this.resolver = null;
      this.onCpu = new CallTreeAggregator({ maxNodes: this.maxNodes });
      this.offCpu = new OffCpuAggregator();
      this.controlStopCount = 0;
    }

    attach(pid, resolver) {
      this.targetPid = pid;
      this.resolver = resolver || new SymbolResolver(pid);
      this.onCpu.reset();
      this.offCpu.reset(pid);
      this.running = pid !== null && pid !== undefined;
    }

    togglePause() {
      this.paused = !this.paused;
      return this.paused;
    }

    clear() {
      this.onCpu.reset();
      this.offCpu.reset(this.targetPid);
    }

    // Guaranteed ControlTraceW(EVENT_TRACE_CONTROL_STOP) cleanup
    stop() {
      if (this.running) {
        this.running = false;
        this.controlStopCount += 1;
      }
    }

    ingestSampledProfile(ev) {
      if (!this.running || this.paused || !ev) return;
      if (this.targetPid !== null && ev.pid !== this.targetPid) return;
      const frames = (ev.stack || []).map(f =>
        f.key ? f : (this.resolver ? this.resolver.resolve(f.module, f.rva) : f)
      );
      this.onCpu.recordSample(frames, { tid: ev.tid, weight: ev.weight || 1, leafFirst: Boolean(ev.leafFirst) });
    }

    ingestOffCpuPair(outEv, readyEv, inEv) {
      if (!this.running || this.paused) return;
      const resolveStack = (stk) => (stk || []).map(f =>
        f.key ? f : (this.resolver ? this.resolver.resolve(f.module, f.rva) : f)
      );
      this.offCpu.onCSwitchOut({ ...outEv, stack: resolveStack(outEv.stack) });
      if (readyEv) this.offCpu.onReadyThread(readyEv);
      this.offCpu.onCSwitchIn(inEv);
    }
  }

  Object.assign(Z, {
    ETW_KERNEL_FLAGS,
    BURST_PROFILES,
    getBurstProfile,
    buildUprofReportCommand,
    locateUprofCli,
    CallTreeAggregator,
    OffCpuAggregator,
    parseUprofBurstReportCsv,
    PmuCoordinator,
    EtwProfilerSession
  });
})();
