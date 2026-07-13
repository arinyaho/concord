// Bounded-concurrency FIFO runner. cap = max concurrent containers; queueMax = max waiting jobs
// (submit returns false when full = the flood bound). Each running job is under a wall-clock:
// on timeout the daemon docker-kills the named container (killing the launch child alone leaves
// the dockerd-managed container orphaned holding the creds mount) and frees the slot.
export function createQueue({ cap, queueMax, jobTimeoutMs, runJob, dockerKill, onOutcome, killTree }) {
  let active = 0;
  const fifo = [];
  const killGroup = killTree ?? ((child) => { if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } });

  function pump() {
    while (active < cap && fifo.length) {
      const job = fifo.shift();
      active++;
      run(job).finally(() => { active--; pump(); });
    }
  }

  async function run(job) {
    let timer;
    let timedOut = false;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        try { killGroup(job.child); } catch {}
        try { dockerKill(job.jobId); } catch {}
        resolve({ code: 124, tail: "timed out" });
      }, jobTimeoutMs);
      timer.unref();
    });
    let outcome;
    try {
      const res = await Promise.race([runJob(job), timeout]);
      outcome = timedOut
        ? { kind: "timeout", code: 124, tail: res.tail }
        : { kind: res.code === 0 ? "done" : "failed", code: res.code, tail: res.tail };
    } catch (e) {
      outcome = { kind: "failed", code: 1, tail: String(e?.message ?? e) };
    } finally {
      clearTimeout(timer);
    }
    onOutcome(job, outcome);
  }

  return {
    submit(job) {
      if (fifo.length >= queueMax) return false;
      fifo.push(job);
      pump();
      return true;
    },
  };
}
