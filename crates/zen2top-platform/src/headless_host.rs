//! Host process lookup and output path validation for the headless CLI.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use anyhow::Context;

/// Finds a running process by numeric PID or executable name.
#[cfg(not(windows))]
pub fn find_target(_target: &str) -> anyhow::Result<Option<(String, u32)>> {
    anyhow::bail!("Process lookup requires Windows.")
}

#[cfg(windows)]
pub use windows::find_target;

/// Checks whether two output paths name the same file without creating either.
pub fn outputs_alias(first: &Path, second: &Path) -> anyhow::Result<bool> {
    let first = output_identity(first).with_context(|| format!("inspect {}", first.display()))?;
    let second =
        output_identity(second).with_context(|| format!("inspect {}", second.display()))?;
    match (first, second) {
        (OutputIdentity::Existing(first), OutputIdentity::Existing(second)) => Ok(first == second),
        (OutputIdentity::Missing(first), OutputIdentity::Missing(second)) => {
            same_missing_path(&first, &second)
        }
        _ => Ok(false),
    }
}

enum OutputIdentity {
    Existing(FileIdentity),
    Missing(PathBuf),
}

fn output_identity(path: &Path) -> io::Result<OutputIdentity> {
    match file_identity(path) {
        Ok(id) => Ok(OutputIdentity::Existing(id)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(OutputIdentity::Missing(
            resolve_output_path(&std::path::absolute(path)?)?,
        )),
        Err(error) => Err(error),
    }
}

fn resolve_output_path(path: &Path) -> io::Result<PathBuf> {
    match fs::canonicalize(path) {
        Ok(path) => Ok(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            match fs::symlink_metadata(path) {
                // An existing entry with an unresolved destination cannot be compared safely.
                Ok(_) => return Err(error),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
                return Err(error);
            };
            Ok(resolve_output_path(parent)?.join(name))
        }
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
type FileIdentity = (u64, u64);

#[cfg(unix)]
fn file_identity(path: &Path) -> io::Result<FileIdentity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = fs::metadata(path)?;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(not(any(unix, windows)))]
type FileIdentity = PathBuf;

#[cfg(not(any(unix, windows)))]
fn file_identity(path: &Path) -> io::Result<FileIdentity> {
    fs::canonicalize(path)
}

#[cfg(not(windows))]
fn same_missing_path(first: &Path, second: &Path) -> anyhow::Result<bool> {
    Ok(first == second)
}

#[cfg(windows)]
use windows::{file_identity, same_missing_path, FileIdentity};

#[cfg(windows)]
mod windows {
    use std::{
        ffi::c_void,
        fs::OpenOptions,
        io,
        mem::size_of,
        os::windows::{
            ffi::OsStrExt,
            fs::OpenOptionsExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
        },
        path::Path,
    };

    const TH32CS_SNAPPROCESS: u32 = 0x0000_0002;
    const ERROR_NO_MORE_FILES: i32 = 18;
    const FILE_READ_ATTRIBUTES: u32 = 0x80;
    const FILE_ID_INFO_CLASS: i32 = 18;
    const CSTR_EQUAL: i32 = 2;

    // SAFETY: These kernel32 declarations match the Windows ABI and SDK layouts below.
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> RawHandle;
        fn Process32FirstW(snapshot: RawHandle, entry: *mut ProcessEntry) -> i32;
        fn Process32NextW(snapshot: RawHandle, entry: *mut ProcessEntry) -> i32;
        fn GetFileInformationByHandleEx(
            file: RawHandle,
            info_class: i32,
            info: *mut c_void,
            size: u32,
        ) -> i32;
        fn CompareStringOrdinal(
            first: *const u16,
            first_len: i32,
            second: *const u16,
            second_len: i32,
            ignore_case: i32,
        ) -> i32;
    }

    #[repr(C)]
    struct ProcessEntry {
        size: u32,
        usage: u32,
        pid: u32,
        default_heap: usize,
        module_id: u32,
        threads: u32,
        parent_pid: u32,
        priority: i32,
        flags: u32,
        exe_file: [u16; 260],
    }

    impl ProcessEntry {
        fn new() -> Self {
            Self {
                size: size_of::<Self>() as u32,
                usage: 0,
                pid: 0,
                default_heap: 0,
                module_id: 0,
                threads: 0,
                parent_pid: 0,
                priority: 0,
                flags: 0,
                exe_file: [0; 260],
            }
        }
    }

    /// Finds a running Windows process without converting its name through a console code page.
    pub fn find_target(target: &str) -> anyhow::Result<Option<(String, u32)>> {
        use anyhow::Context;

        lookup_process(target).with_context(|| format!("look up Windows process {target}"))
    }

    fn lookup_process(target: &str) -> io::Result<Option<(String, u32)>> {
        let target_pid = target.parse::<u32>().ok();
        let target_name: Vec<_> = target.encode_utf16().collect();
        // SAFETY: TH32CS_SNAPPROCESS requests a read-only process snapshot and ignores the PID.
        let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if raw as isize == -1 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: The successful call returned a new handle that must be closed once.
        let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut entry = ProcessEntry::new();
        // SAFETY: The snapshot is live and entry has the required size and writable layout.
        let mut found = unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) };
        while found != 0 {
            let end = entry
                .exe_file
                .iter()
                .position(|&unit| unit == 0)
                .unwrap_or(entry.exe_file.len());
            let name = &entry.exe_file[..end];
            let matches = match target_pid {
                Some(pid) => pid == entry.pid,
                None => eq_windows_name(name, &target_name)?,
            };
            if matches {
                return Ok(Some((String::from_utf16_lossy(name), entry.pid)));
            }
            // SAFETY: The live snapshot and initialized entry are reused for the next result.
            found = unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) };
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_NO_MORE_FILES) {
            Ok(None)
        } else {
            Err(error)
        }
    }

    #[repr(C)]
    #[derive(PartialEq, Eq)]
    pub(super) struct FileIdentity {
        volume_serial: u64,
        file_id: [u8; 16],
    }

    pub(super) fn file_identity(path: &Path) -> io::Result<FileIdentity> {
        let file = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .open(path)?;
        let mut info = FileIdentity {
            volume_serial: 0,
            file_id: [0; 16],
        };
        // SAFETY: The handle is borrowed from a live file and info is a writable FILE_ID_INFO.
        let found = unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FILE_ID_INFO_CLASS,
                (&mut info as *mut FileIdentity).cast(),
                size_of::<FileIdentity>() as u32,
            )
        };
        if found == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(info)
    }

    pub(super) fn same_missing_path(first: &Path, second: &Path) -> anyhow::Result<bool> {
        let first: Vec<_> = first.as_os_str().encode_wide().collect();
        let second: Vec<_> = second.as_os_str().encode_wide().collect();
        Ok(eq_windows_name(&first, &second)?)
    }

    fn eq_windows_name(first: &[u16], second: &[u16]) -> io::Result<bool> {
        if first.len() != second.len() || first.is_empty() {
            return Ok(first == second);
        }
        let len = i32::try_from(first.len()).map_err(io::Error::other)?;
        // SAFETY: Both slices contain len readable UTF-16 code units.
        let result = unsafe { CompareStringOrdinal(first.as_ptr(), len, second.as_ptr(), len, 1) };
        if result == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(result == CSTR_EQUAL)
    }
}
