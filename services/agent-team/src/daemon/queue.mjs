// Bounded-concurrency FIFO runner. cap = max concurrent containers; queueMax = max waiting jobs
// (submit returns false when full = the flood bound). Each running job is under a wall-clock:
// on timeout the daemon docker-kills the named container (killing the launch child alone leaves
// the dockerd-managed container orphaned holding the creds mount) and frees the slot. cancel(jobId)
// stops a running or queued job on demand (same kill as the timeout), producing a `cancelled`
// outcome; list() reports running + queued jobs for the /status control verb.
// Pure outcome computation, extracted so the cancel > timeout precedence can be unit-pinned
// (setting both `_cancelled` and `timedOut` via the real timer is flaky). cancelled is checked
// FIRST: a cancel that lands in the same tick as a timeout must still report "cancelled".
export function computeOutcome({ cancelled, timedOut, res }) {
  if (cancelled) return { kind: "cancelled", code: 130, tail: "cancelled" };
  if (timedOut) return { kind: "timeout", code: 124, tail: res.tail };
  return { kind: res.code === 0 ? "done" : "failed", code: res.code, tail: res.tail };
}

export function createQueue({ cap, queueMax, jobTimeoutMs, runJob, dockerKill, onOutcome, killTree }) {
  let active = 0;
  const fifo = [];
  const running = new Map(); // jobId -> job (jobs currently in run())
  const killGroup = killTree ?? ((child) => { if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } });

  function pump() {
    while (active < cap && fifo.length) {
      const job = fifo.shift();
      active++;
      running.set(job.jobId, job);
      run(job).finally(() => { active--; running.delete(job.jobId); pump(); });
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
    // Cancel arm: cancel(jobId) sets job._cancelled + kills + resolves this. Stash it before
    // onStart, which is allowed to synchronously cancel the job it observes as running.
    const cancel = new Promise((resolve) => { job._cancelResolve = resolve; });
    try {
      const startPromise = job.onStart?.();
      Promise.resolve(startPromise).catch(() => {});
    } catch {}
    let outcome;
    try {
      // A synchronous onStart cancellation has already resolved the cancel arm. Do not launch
      // work after that cancellation has killed the job's container.
      const res = await (job._cancelled ? cancel : Promise.race([runJob(job), timeout, cancel]));
      outcome = computeOutcome({ cancelled: job._cancelled, timedOut, res });
    } catch (e) {
      outcome = { kind: "failed", code: 1, tail: String(e?.message ?? e) };
    } finally {
      clearTimeout(timer);
    }
    let terminalPromise;
    try {
      terminalPromise = Promise.resolve(job.onTerminal?.(outcome));
    } catch (e) {
      terminalPromise = Promise.reject(e);
    }
    // Mark this promise handled immediately; the outcome router observes the same promise and
    // reports a rejection before it routes the final response.
    terminalPromise.catch(() => {});
    onOutcome(job, outcome, terminalPromise);
  }

  const summarize = (j) => ({ jobId: j.jobId, alias: j.alias, task: j.task, threadId: j.threadId });

  return {
    submit(job) {
      if (fifo.length >= queueMax) return false;
      fifo.push(job);
      pump();
      return true;
    },
    cancel(jobId) {
      const runningJob = running.get(jobId);
      if (runningJob) {
        runningJob._cancelled = true;
        try { killGroup(runningJob.child); } catch {}
        try { dockerKill(jobId); } catch {}
        runningJob._cancelResolve?.({ code: 130, tail: "cancelled" });
        return { found: true };
      }
      const i = fifo.findIndex((j) => j.jobId === jobId);
      if (i >= 0) {
        const [queuedJob] = fifo.splice(i, 1);
        onOutcome(queuedJob, { kind: "cancelled", code: 130, tail: "cancelled" });
        return { found: true };
      }
      return { found: false };
    },
    list() {
      return { running: [...running.values()].map(summarize), queued: fifo.map(summarize) };
    },
  };
}
