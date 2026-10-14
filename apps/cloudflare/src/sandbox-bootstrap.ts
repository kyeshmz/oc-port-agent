import {
  RUNNER_PRIVILEGE_DROP_SHA256,
  RUNNER_PRIVILEGE_DROP_SOURCE,
  TRUSTED_VERIFIER_HELPER_GZIP_BASE64,
  TRUSTED_VERIFIER_HELPER_SHA256,
} from './sandbox-helper-assets.js';

export const SANDBOX_VERIFIER_PATH = '/opt/oc-port-agent/verify.py';
export const SANDBOX_RUNNER_LAUNCHER_PATH = '/opt/oc-port-agent/run-as-runner.py';
export const SANDBOX_BOOTSTRAP_READY_PREFIX = 'OCPA_VERIFIER_BOOTSTRAP_V1\n';

export interface SandboxBootstrapDirectoryStatus {
  path: string;
  uid: 0;
  gid: 0;
  mode: '0755';
}

export interface SandboxBootstrapFileStatus {
  path: string;
  sha256: string;
  uid: 0;
  gid: 0;
  mode: '0555';
}

export interface SandboxVerifierBootstrapStatus {
  schemaVersion: 1;
  status: 'ready';
  directories: SandboxBootstrapDirectoryStatus[];
  files: SandboxBootstrapFileStatus[];
  runner: { name: 'runner'; uid: number; gid: number };
}

const directories = Object.freeze([
  Object.freeze({ path: '/etc', uid: 0 as const, gid: 0 as const, mode: '0755' as const }),
  Object.freeze({ path: '/opt', uid: 0 as const, gid: 0 as const, mode: '0755' as const }),
  Object.freeze({ path: '/opt/oc-port-agent', uid: 0 as const, gid: 0 as const, mode: '0755' as const }),
]);

const files = Object.freeze([
  Object.freeze({
    path: SANDBOX_RUNNER_LAUNCHER_PATH,
    sha256: RUNNER_PRIVILEGE_DROP_SHA256,
    uid: 0 as const,
    gid: 0 as const,
    mode: '0555' as const,
  }),
  Object.freeze({
    path: SANDBOX_VERIFIER_PATH,
    sha256: TRUSTED_VERIFIER_HELPER_SHA256,
    uid: 0 as const,
    gid: 0 as const,
    mode: '0555' as const,
  }),
]);

/** Static identity and closed readiness shape shared with the live controller. */
export const sandboxVerifierBootstrapMetadata = Object.freeze({
  schemaVersion: 1 as const,
  readyPrefix: SANDBOX_BOOTSTRAP_READY_PREFIX,
  directories,
  files,
  runnerName: 'runner' as const,
});

const PYTHON_BOOTSTRAP = String.raw`
import base64
import grp
import hashlib
import json
import os
import pwd
import stat
import sys
import zlib

HELPER_GZIP_B64 = ${JSON.stringify(TRUSTED_VERIFIER_HELPER_GZIP_BASE64)}
HELPER_SHA256 = ${JSON.stringify(TRUSTED_VERIFIER_HELPER_SHA256)}
LAUNCHER_SOURCE = ${JSON.stringify(RUNNER_PRIVILEGE_DROP_SOURCE)}
LAUNCHER_SHA256 = ${JSON.stringify(RUNNER_PRIVILEGE_DROP_SHA256)}
READY_PREFIX = ${JSON.stringify(SANDBOX_BOOTSTRAP_READY_PREFIX)}
HELPER_PATH = ${JSON.stringify(SANDBOX_VERIFIER_PATH)}
LAUNCHER_PATH = ${JSON.stringify(SANDBOX_RUNNER_LAUNCHER_PATH)}
RUNNER_NAME = "runner"
MAX_ACCOUNT_FILE_BYTES = 2_000_000
MAX_HELPER_BYTES = 65_536

def require(condition):
    if not condition:
        raise ValueError("bootstrap prerequisite rejected")

def directory_metadata(path, *, create=False):
    if create:
        try:
            os.mkdir(path, 0o755)
        except FileExistsError:
            pass
    metadata = os.lstat(path)
    require(stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode))
    require(metadata.st_uid == 0 and metadata.st_gid == 0)
    require(stat.S_IMODE(metadata.st_mode) == 0o755)
    return {"path": path, "uid": metadata.st_uid, "gid": metadata.st_gid,
            "mode": format(stat.S_IMODE(metadata.st_mode), "04o")}

def read_bounded_regular_file(path, *, expected_mode=None):
    flags = os.O_RDONLY | os.O_NOFOLLOW
    fd = os.open(path, flags)
    try:
        metadata = os.fstat(fd)
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_nlink == 1)
        require(metadata.st_uid == 0 and metadata.st_gid == 0)
        mode = stat.S_IMODE(metadata.st_mode)
        if expected_mode is not None:
            require(mode == expected_mode)
        else:
            require(mode & 0o022 == 0)
        require(metadata.st_size <= MAX_ACCOUNT_FILE_BYTES)
        chunks = []
        total = 0
        while total <= MAX_ACCOUNT_FILE_BYTES:
            chunk = os.read(fd, min(65536, MAX_ACCOUNT_FILE_BYTES + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        require(total <= MAX_ACCOUNT_FILE_BYTES and total == metadata.st_size)
        return b"".join(chunks)
    finally:
        os.close(fd)

def append_account_record(path, record):
    before = os.lstat(path)
    current = read_bounded_regular_file(path)
    require(current.endswith(b"\n"))
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(fd)
        require(metadata.st_dev == before.st_dev and metadata.st_ino == before.st_ino)
        require(stat.S_ISREG(metadata.st_mode) and metadata.st_uid == 0 and metadata.st_gid == 0)
        require(stat.S_IMODE(metadata.st_mode) & 0o022 == 0)
        view = memoryview(record)
        while view:
            written = os.write(fd, view)
            require(written > 0)
            view = view[written:]
        os.fsync(fd)
    finally:
        os.close(fd)

def validate_runner_account():
    users = [account for account in pwd.getpwall() if account.pw_name == RUNNER_NAME]
    groups = [group for group in grp.getgrall() if group.gr_name == RUNNER_NAME]
    require(len(users) == 1 and len(groups) == 1)
    account = users[0]
    group = groups[0]
    require(account.pw_uid > 0 and account.pw_gid > 0 and account.pw_gid == group.gr_gid)
    require(not any(other.pw_name != RUNNER_NAME and other.pw_uid == account.pw_uid
                    for other in pwd.getpwall()))
    require(not any(other.gr_name != RUNNER_NAME and other.gr_gid == group.gr_gid
                    for other in grp.getgrall()))
    return account

def ensure_runner_account():
    read_bounded_regular_file("/etc/passwd")
    read_bounded_regular_file("/etc/group")
    users = [account for account in pwd.getpwall() if account.pw_name == RUNNER_NAME]
    groups = [group for group in grp.getgrall() if group.gr_name == RUNNER_NAME]
    require(len(users) <= 1 and len(groups) <= 1)
    if users:
        require(len(groups) == 1 and users[0].pw_gid == groups[0].gr_gid)
        return validate_runner_account()

    all_users = pwd.getpwall()
    all_groups = grp.getgrall()
    used_uids = {account.pw_uid for account in all_users}
    used_gids = {group.gr_gid for group in all_groups}
    if groups:
        gid = groups[0].gr_gid
        require(gid > 0 and not any(group.gr_name != RUNNER_NAME and group.gr_gid == gid
                                    for group in all_groups))
        uid = next((candidate for candidate in range(60000, 65534) if candidate not in used_uids), None)
        require(uid is not None)
    else:
        candidate = next((value for value in range(60000, 65534)
                          if value not in used_uids and value not in used_gids), None)
        require(candidate is not None)
        uid = candidate
        gid = candidate
        append_account_record("/etc/group", ("runner:x:%d:\n" % gid).encode("ascii"))

    passwd_record = ("runner:x:%d:%d:Trusted verifier runner:/tmp/ocpa-home:/usr/sbin/nologin\n"
                     % (uid, gid)).encode("ascii")
    append_account_record("/etc/passwd", passwd_record)
    return validate_runner_account()

def expected_file_bytes():
    require(len(HELPER_GZIP_B64) <= 131_072)
    compressed = base64.b64decode(HELPER_GZIP_B64, validate=True)
    decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS)
    helper = decompressor.decompress(compressed, MAX_HELPER_BYTES + 1)
    require(len(helper) <= MAX_HELPER_BYTES and decompressor.eof)
    require(not decompressor.unconsumed_tail and not decompressor.unused_data)
    launcher = LAUNCHER_SOURCE.encode("utf-8", errors="strict")
    require(len(launcher) <= 16_384)
    require(hashlib.sha256(helper).hexdigest() == HELPER_SHA256)
    require(hashlib.sha256(launcher).hexdigest() == LAUNCHER_SHA256)
    return helper, launcher

def inspect_expected_file(path, expected_bytes, expected_sha256):
    metadata = os.lstat(path)
    require(stat.S_ISREG(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode))
    require(metadata.st_uid == 0 and metadata.st_gid == 0 and metadata.st_nlink == 1)
    require(stat.S_IMODE(metadata.st_mode) == 0o555)
    require(metadata.st_size == len(expected_bytes))
    content = read_bounded_regular_file(path, expected_mode=0o555)
    require(content == expected_bytes)
    digest = hashlib.sha256(content).hexdigest()
    require(digest == expected_sha256)
    return {"path": path, "sha256": digest, "uid": metadata.st_uid,
            "gid": metadata.st_gid, "mode": format(stat.S_IMODE(metadata.st_mode), "04o")}

def install_or_verify_file(path, expected_bytes, expected_sha256):
    try:
        os.lstat(path)
    except FileNotFoundError:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
        fd = os.open(path, flags, 0o555)
        try:
            os.fchown(fd, 0, 0)
            view = memoryview(expected_bytes)
            while view:
                written = os.write(fd, view)
                require(written > 0)
                view = view[written:]
            os.fchmod(fd, 0o555)
            os.fsync(fd)
        finally:
            os.close(fd)
    return inspect_expected_file(path, expected_bytes, expected_sha256)

def initialize():
    require(os.getuid() == 0 and os.geteuid() == 0)
    require(hasattr(os, "O_NOFOLLOW") and hasattr(os, "O_EXCL"))
    require(os.path.isdir("/opt") and os.path.isdir("/etc"))
    etc_metadata = directory_metadata("/etc")
    opt_metadata = directory_metadata("/opt")
    helper_directory_metadata = directory_metadata("/opt/oc-port-agent", create=True)
    helper_bytes, launcher_bytes = expected_file_bytes()
    launcher_metadata = install_or_verify_file(LAUNCHER_PATH, launcher_bytes, LAUNCHER_SHA256)
    helper_metadata = install_or_verify_file(HELPER_PATH, helper_bytes, HELPER_SHA256)
    account = ensure_runner_account()
    return {
        "schemaVersion": 1,
        "status": "ready",
        "directories": sorted([etc_metadata, opt_metadata, helper_directory_metadata],
                               key=lambda item: item["path"]),
        "files": sorted([launcher_metadata, helper_metadata], key=lambda item: item["path"]),
        "runner": {"name": RUNNER_NAME, "uid": account.pw_uid, "gid": account.pw_gid},
    }

def main():
    try:
        status = initialize()
        sys.stdout.write(READY_PREFIX)
        sys.stdout.write(json.dumps(status, separators=(",", ":"), sort_keys=True))
        return 0
    except BaseException:
        return 2

raise SystemExit(main())
`;

export function makeSandboxBootstrapCommand(): readonly [string, ...string[]] {
  return ['python3', '-I', '-c', PYTHON_BOOTSTRAP];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function matchesDirectory(value: unknown, expected: SandboxBootstrapDirectoryStatus): boolean {
  return hasExactKeys(value, ['path', 'uid', 'gid', 'mode'])
    && value.path === expected.path
    && value.uid === expected.uid
    && value.gid === expected.gid
    && value.mode === expected.mode;
}

function matchesFile(value: unknown, expected: SandboxBootstrapFileStatus): boolean {
  return hasExactKeys(value, ['path', 'sha256', 'uid', 'gid', 'mode'])
    && value.path === expected.path
    && value.sha256 === expected.sha256
    && value.uid === expected.uid
    && value.gid === expected.gid
    && value.mode === expected.mode;
}

/** Only the exact closed root/helper/runner metadata response is accepted. */
export function isVerifiedSandboxBootstrapOutput(output: string): boolean {
  if (!output.startsWith(SANDBOX_BOOTSTRAP_READY_PREFIX)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(SANDBOX_BOOTSTRAP_READY_PREFIX.length));
  } catch {
    return false;
  }
  if (!hasExactKeys(parsed, ['schemaVersion', 'status', 'directories', 'files', 'runner'])
    || parsed.schemaVersion !== sandboxVerifierBootstrapMetadata.schemaVersion
    || parsed.status !== 'ready'
    || !Array.isArray(parsed.directories)
    || parsed.directories.length !== sandboxVerifierBootstrapMetadata.directories.length
    || !Array.isArray(parsed.files)
    || parsed.files.length !== sandboxVerifierBootstrapMetadata.files.length
    || !hasExactKeys(parsed.runner, ['name', 'uid', 'gid'])) {
    return false;
  }
  if (!parsed.directories.every((item, index) => matchesDirectory(
    item,
    sandboxVerifierBootstrapMetadata.directories[index]!,
  )) || !parsed.files.every((item, index) => matchesFile(
    item,
    sandboxVerifierBootstrapMetadata.files[index]!,
  ))) {
    return false;
  }
  return parsed.runner.name === sandboxVerifierBootstrapMetadata.runnerName
    && typeof parsed.runner.uid === 'number'
    && Number.isSafeInteger(parsed.runner.uid)
    && parsed.runner.uid > 0
    && parsed.runner.uid <= 2_147_483_647
    && typeof parsed.runner.gid === 'number'
    && Number.isSafeInteger(parsed.runner.gid)
    && parsed.runner.gid > 0
    && parsed.runner.gid <= 2_147_483_647;
}
