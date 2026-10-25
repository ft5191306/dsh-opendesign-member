/**
 * Decide what one `opendesign_ask` call means.
 *
 * Kept as a pure function, apart from the tool, for one reason: this is the part
 * that is easy to get wrong and cheap to test. The tool around it does I/O (read
 * the run, cancel it, start a turn); this decides WHICH of those to do.
 *
 * The shapes:
 *
 *   `collect` — a run already exists and the caller wants its answer. A read.
 *   `run`     — a new turn, optionally after INTERRUPTING a live one.
 *
 * Redirection is cancel-and-restart, because that is what Open Design's own
 * 「引导对话」 actually does. Measured against a live `amr` turn on 2026-10-25:
 * pressing it produced a NEW run while the old one was still working, left NO
 * user message row for the typed text, and marked the old run `cancel_origin:
 * user_stop`. `POST /runs/:id/steer` — the route whose refusal made this look
 * impossible — is not what the button calls: it answers 409
 * `RUN_STEERING_UNSUPPORTED` on this CLI, whose stdin closes with the opening
 * prompt.
 *
 * So an interruption here is honest about its cost: the running turn is stopped
 * and its unfinished work is lost. The tool reports what the stopped run had
 * produced, so the caller can see what it traded away.
 *
 * @module @local/dsh-opendesign-member/lib/turn-plan
 */

/**
 * Plan one call.
 *
 * @param input - the call's arguments plus the recorded state for one member.
 * @param input.runId - collect this existing run instead of starting anything.
 * @param input.inject - text that should redirect the turn in flight.
 * @param input.prompt - the prompt for a new turn.
 * @param input.hasFormAnswers - whether form answers were supplied.
 * @param input.pendingRun - `{ runId }` of a turn this bridge stopped waiting for.
 * @param input.pendingRunActive - whether that run is still live; `false` means it
 *   settled and the record is stale, `undefined` means the caller did not check.
 * @returns a plan: `{ kind: 'collect' | 'run' | 'error' }`.
 */
export function planTurn(input = {}) {
  const runId = trimmed(input.runId);
  const inject = trimmed(input.inject);
  const prompt = typeof input.prompt === 'string' ? input.prompt : undefined;
  const hasPrompt = typeof prompt === 'string' && prompt.trim().length > 0;
  const pendingRunId = trimmed(input.pendingRun?.runId);

  // 1. Collecting an existing run is a READ. It must never also send something:
  //    that would start a second turn on top of the one being collected.
  if (runId !== undefined) {
    return { kind: 'collect', runId };
  }

  // 2. Redirection: stop the live turn, then run the text as the next one.
  //
  //    The text is NOT written into the conversation beforehand. It becomes the
  //    new turn's prompt, which the daemon records as that run's own user
  //    message — the same one row a normal turn produces. Writing it first and
  //    then running it would leave the sentence in the history twice.
  if (inject !== undefined) {
    if (pendingRunId === undefined) {
      // Nothing in flight: "say this now" simply means "run this now".
      return { kind: 'run', prompt: inject, injectedAsTurn: true };
    }
    if (input.pendingRunActive === false) {
      // The recorded run already settled, so there is nothing to interrupt. The
      // caller's intent is still "this is my next instruction".
      return { kind: 'run', prompt: inject, injectedAsTurn: true, staleRunId: pendingRunId };
    }
    return { kind: 'run', prompt: inject, interruptRunId: pendingRunId };
  }

  // 3. A plain turn — carrying whether it is a REPLY.
  //
  //    `answersReply` is not cosmetic. Form answers are the reply to a question
  //    Open Design is blocked on, not a new request, so a caller must not treat
  //    them like one: holding them back leaves the conversation stuck on a form
  //    that will be asked again. It is reported on the plan so that decision lives
  //    in one place instead of in a variable at the call site.
  if (hasPrompt) {
    return {
      kind: 'run',
      prompt,
      ...(input.hasFormAnswers === true ? { answersReply: true } : {}),
    };
  }

  // Nothing to do, and say why: a plain ask with no prompt is a caller mistake,
  // not a request to guess.
  return {
    kind: 'error',
    reason: 'no prompt, no form answers, nothing to collect',
  };
}

/** Trim to a non-empty string, or undefined. */
function trimmed(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Build the `message` a run is created with.
 *
 * The sender prefix must appear EXACTLY ONCE, and getting this wrong is invisible
 * until somebody reads the conversation: a turn adopting an existing row sends
 * that row's own text, which already carries the prefix, so prefixing again
 * produced `[lead (DSH lead)]\n\n[lead (DSH lead)]\n\n<the sentence>` in the
 * window — measured on 2026-10-25, from the very feature this file plans.
 *
 * @param input.sender - `<name> (DSH <role>)`, prefixed onto a normal prompt.
 * @param input.prompt - the prompt (already-final row text when adopting a row).
 * @param input.userMessageId - set only when this turn adopts an existing row.
 * @returns the exact `message` to send.
 */
export function composeRunMessage(input = {}) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (typeof input.userMessageId === 'string' && input.userMessageId.length > 0) {
    // The row IS the message: the daemon overwrites the adopted row's content with
    // this string, so anything other than the row text would rewrite what the
    // human already read.
    return prompt;
  }
  if (typeof input.sender === 'string' && input.sender.length > 0) {
    return `[${input.sender}]\n\n${prompt}`;
  }
  return prompt;
}
