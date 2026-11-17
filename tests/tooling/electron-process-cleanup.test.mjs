import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import process from "node:process";
import { afterEach, mock, test } from "node:test";
import { cleanupGroup, groupAlive } from "../../scripts/electron-process-cleanup.mjs";

const pid = 765432;
const original = "Mon Jul 13 10:00:00 2026";
const failure = (code) => Object.assign(new Error(`injected ${code}`), { code });
function probes({ members = "", status = 0, leader = original, leaderStatus = 0 } = {}) {
  const probe = mock.method(childProcess, "spawnSync", (_command, args) =>
    args[0] === "-axo" ? { status, stdout: members } : { status: leaderStatus, stdout: leader },
  );
  syncBuiltinESMExports();
  return probe;
}
function signals(implementation) {
  return mock.method(process, "kill", implementation);
}
afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

test("ordinary cleanup escalates only its owned group and waits for exit", async () => {
  probes();
  let dead = false;
  const kill = signals((_pid, signal) => {
    if (signal === "SIGKILL") dead = true;
    if (signal === 0 && dead) throw failure("ESRCH");
    return true;
  });
  await cleanupGroup(pid, original, "SIGTERM", 0);
  assert.deepEqual(
    kill.mock.calls.map(({ arguments: args }) => args),
    [
      [-pid, 0],
      [-pid, "SIGTERM"],
      [-pid, 0],
      [-pid, "SIGKILL"],
      [-pid, 0],
    ],
  );
});

test("already-exited groups (ESRCH) never receive a signal", async () => {
  const probe = probes();
  const kill = signals(() => {
    throw failure("ESRCH");
  });
  await cleanupGroup(pid, original, "SIGTERM", 0);
  assert.equal(probe.mock.callCount(), 0);
  assert.ok(kill.mock.calls.every(({ arguments: args }) => args[1] === 0));
});

for (const code of ["ESRCH", "EPERM"]) {
  for (const phase of ["SIGTERM", "SIGKILL"]) {
    test(`${code} during ${phase} after process exit is benign`, async () => {
      probes({ members: `${pid} Z\n999 S\n` });
      let exited = false;
      const kill = signals((_pid, signal) => {
        if (signal === phase) {
          exited = true;
          throw failure(code);
        }
        if (signal === 0 && exited) throw failure("ESRCH");
        return true;
      });
      await cleanupGroup(pid, original, "SIGTERM", 0);
      assert.ok(kill.mock.calls.every(({ arguments: args }) => args[0] === -pid));
    });
  }
}

for (const members of ["", `${pid} Z\n${pid} Z+\n999 S\n`]) {
  test(`EPERM liveness probe accepts only absent/zombie members: ${JSON.stringify(members)}`, async () => {
    probes({ members });
    const kill = signals(() => {
      throw failure("EPERM");
    });
    await cleanupGroup(pid, original, "SIGTERM", 0);
    assert.ok(kill.mock.calls.every(({ arguments: args }) => args[1] === 0));
  });
}

test("EPERM from a live group remains a permission failure", async () => {
  probes({ members: `${pid} S\n` });
  const denied = failure("EPERM");
  signals(() => {
    throw denied;
  });
  assert.equal(groupAlive(pid), true);
  await assert.rejects(cleanupGroup(pid, original, "SIGTERM", 0), (error) => error === denied);
});

test("EPERM is not hidden when membership inspection fails", async () => {
  probes({ status: 1 });
  const denied = failure("EPERM");
  signals((_pid, signal) => {
    if (signal !== 0) throw denied;
    return true;
  });
  await assert.rejects(cleanupGroup(pid, original, "SIGTERM", 0), (error) => error === denied);
});

for (const phase of [0, "SIGTERM", "SIGKILL"]) {
  test(`unexpected error at ${phase} is preserved`, async () => {
    probes();
    const unexpected = failure("EIO");
    signals((_pid, signal) => {
      if (signal === phase) throw unexpected;
      return true;
    });
    await assert.rejects(
      cleanupGroup(pid, original, "SIGTERM", 0),
      (error) => error === unexpected,
    );
  });
}

test("a reused leader PID is not signalled", async () => {
  probes({ leader: "Mon Jul 13 10:01:00 2026" });
  const kill = signals(() => true);
  await assert.rejects(cleanupGroup(pid, original, "SIGTERM", 0), /identity changed/);
  assert.deepEqual(
    kill.mock.calls.map(({ arguments: args }) => args),
    [[-pid, 0]],
  );
});

test("leader identity is rechecked before escalation", async () => {
  let leader = original;
  mock.method(childProcess, "spawnSync", () => ({ status: 0, stdout: leader }));
  syncBuiltinESMExports();
  const kill = signals((_pid, signal) => {
    if (signal === "SIGTERM") leader = "new owner";
    return true;
  });
  await assert.rejects(cleanupGroup(pid, original, "SIGTERM", 0), /identity changed/);
  assert.ok(!kill.mock.calls.some(({ arguments: args }) => args[1] === "SIGKILL"));
});

test("surviving descendants can be cleaned after their leader exits", async () => {
  probes({ leader: "", leaderStatus: 1 });
  let exited = false;
  signals((_pid, signal) => {
    if (signal === "SIGTERM") exited = true;
    if (signal === 0 && exited) throw failure("ESRCH");
    return true;
  });
  await cleanupGroup(pid, original, "SIGTERM", 0);
});

test("failed leader inspection or missing ownership never permits a signal", async () => {
  probes({ leader: "", leaderStatus: 2 });
  const kill = signals(() => true);
  await assert.rejects(cleanupGroup(pid, original, "SIGTERM", 0), /Cannot verify/);
  await assert.rejects(cleanupGroup(pid, "", "SIGTERM", 0), /identity changed or unknown/);
  assert.ok(kill.mock.calls.every(({ arguments: args }) => args[1] === 0));
});
