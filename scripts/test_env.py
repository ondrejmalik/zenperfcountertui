#!/usr/bin/env python3
"""Isolated scratch environment, normalized env fingerprint, and OS job/process-group supervisor."""
from __future__ import annotations

import contextlib
import ctypes
import os
from pathlib import Path
import platform
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
from typing import Iterator


def env_fingerprint(profile: str = "release") -> dict[str, str | int]:
    """Return a normalized host/toolchain fingerprint for pr_ready.py and bench_baab.py parity checks."""
    return {
        "os": platform.system().lower(),
        "arch": platform.machine().lower(),
        "cpu_count": os.cpu_count() or 0,
        "python": f"{sys.version_info.major}.{sys.version_info.minor}",
        "profile": profile,
    }


def free_loopback_port() -> int:
    """Bind 127.0.0.1:0 to obtain an ephemeral free localhost port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def make_scratch_env(prefix: str = "ZEN2TOP", base_dir: Path | None = None) -> tuple[dict[str, str], Path]:
    """Create a fresh scratch directory and return (env_dict, scratch_path)."""
    root = Path(tempfile.mkdtemp(prefix=f"{prefix.lower()}-scratch-", dir=base_dir))
    dirs = {
        f"{prefix}_HOME": root / "home",
        f"{prefix}_CONFIG_HOME": root / "config",
        "APPDATA": root / "appdata",
        "LOCALAPPDATA": root / "localappdata",
        "XDG_DATA_HOME": root / "xdg-data",
        "XDG_CONFIG_HOME": root / "xdg-config",
        "XDG_RUNTIME_DIR": root / "xdg-runtime",
    }
    for d in dirs.values():
        d.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    for k, v in dirs.items():
        env[k] = str(v)
    env.update({
        f"{prefix}_NO_AUDIO": "1",
        f"{prefix}_NO_SELF_UPDATE": "1",
        f"{prefix}_TELEMETRY_URL": "off",
        f"{prefix}_TEST_LOOPBACK": "1",
        f"{prefix}_STILL": "1",
        "PYTHONUTF8": "1",
    })
    return env, root


class SupervisedProcess:
    """Subprocess bound to a Windows Job Object (kill-on-close) or POSIX process group."""

    def __init__(self, cmd: list[str], env: dict[str, str], cwd: Path | None = None) -> None:
        self._job_handle = None
        kwargs: dict = {
            "cwd": str(cwd) if cwd else None,
            "env": env,
            "stdin": subprocess.PIPE,
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
        }
        if os.name == "nt":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True

        self.proc = subprocess.Popen(cmd, **kwargs)
        if os.name == "nt":
            self._bind_windows_job(self.proc._handle)

    def _bind_windows_job(self, proc_handle: int) -> None:
        kernel32 = ctypes.windll.kernel32
        job = kernel32.CreateJobObjectW(None, None)
        if not job:
            return

        class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", ctypes.c_uint32),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", ctypes.c_uint32),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", ctypes.c_uint32),
                ("SchedulingClass", ctypes.c_uint32),
            ]

        class IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                (f, ctypes.c_uint64)
                for f in ("ReadOp", "WriteOp", "OtherOp", "ReadBytes", "WriteBytes", "OtherBytes")
            ]

        class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        kernel32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info))
        kernel32.AssignProcessToJobObject(job, int(proc_handle))
        self._job_handle = job

    def stop(self) -> None:
        if self.proc.poll() is None:
            if os.name == "nt":
                self.proc.terminate()
            else:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        for pipe in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            if pipe is not None:
                with contextlib.suppress(OSError):
                    pipe.close()
        if os.name == "nt" and self._job_handle:
            ctypes.windll.kernel32.CloseHandle(self._job_handle)
            self._job_handle = None


@contextlib.contextmanager
def isolated_run(cmd: list[str], prefix: str = "ZEN2TOP") -> Iterator[tuple[SupervisedProcess, Path]]:
    env, scratch = make_scratch_env(prefix=prefix)
    sup = SupervisedProcess(cmd, env=env, cwd=scratch)
    try:
        yield sup, scratch
    finally:
        sup.stop()
        shutil.rmtree(scratch, ignore_errors=True)
