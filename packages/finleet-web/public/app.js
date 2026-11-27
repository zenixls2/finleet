import { applyConversationEvent, createConversationProjection, formatFeedTime, validFeedMode } from "./conversation.js";

(() => {
  "use strict";
  const config = window.FINLEET_CONFIG;
  const conversation = document.querySelector("#conversation");
  const stream = document.querySelector("#stream");
  const empty = document.querySelector("#empty-state");
  const count = document.querySelector("#event-count");
  const dot = document.querySelector("#connection-dot");
  const connection = document.querySelector("#connection-label");
  const session = document.querySelector("#session-label");
  const runState = document.querySelector("#run-state");
  const runDetail = document.querySelector("#run-detail");
  const runIndicator = document.querySelector("#run-indicator");
  const permissions = document.querySelector("#permissions");
  const form = document.querySelector("#prompt-form");
  const prompt = document.querySelector("#prompt");
  const send = document.querySelector("#send");
  const cancel = document.querySelector("#cancel");
  const feedSelect = document.querySelector("#feed-mode");
  const seen = new Set();
  const pending = new Map();
  const permissionCards = new Map();
  const conversationProjection = createConversationProjection();
  const conversationViews = new Map();
  const queuedEvents = [];
  let socket;
  let nextId = 1;
  let framePending = false;
  let eventCount = 0;
  let retry = 0;
  let active = false;
  let feedMode = localStorage.getItem("finleet.chat-clean.feed") || "clean";
  if (!validFeedMode(feedMode)) feedMode = "clean";
  feedSelect.value = feedMode;
  document.querySelector(".activity-panel").open = feedMode === "raw";

  session.textContent = config.sessionId;
  const setConnection = (state, label) => {
    dot.className = `dot ${state}`;
    connection.textContent = label;
  };
  const call = (method, params) => new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) { reject(new Error("Core connection is unavailable")); return; }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  });
  const text = (value) => typeof value === "string" ? value : "";
  const detailFor = (event) => {
    const data = event.data || {};
    switch (event.kind) {
      case "PromptAdmitted": return data.prompt;
      case "ProviderTurnStarted": return `${data.provider || "agent"} / ${data.model || ""}`;
      case "ProviderText": return data.text;
      case "HarnessThinking": return `${data.step || "Thinking"} — ${data.text || ""}`;
      case "ToolCalled": return `${data.name || "Tool"}${data.arguments ? ` · ${data.arguments}` : ""}`;
      case "ToolSucceeded": return data.result || data.preview;
      case "ToolFailed": case "ProviderTurnFailed": return `${data.code || "FAILED"} — ${data.message || ""}`;
      case "TaskConclusion": return data.summary;
      case "BackgroundAgentCreated": return `${data.profile || "agent"} · ${data.task || ""}`;
      case "BackgroundAgentStatus": return `${data.status || "status"}${data.detail ? ` — ${data.detail}` : ""}${data.outputPreview ? `\n${data.outputPreview}` : ""}`;
      case "GraphTransition": return `${data.nodeId || "graph"} · ${data.outcome || ""}`;
      case "GraphPlanPublished": case "ImprovementProposed": return `Plan ${data.plan?.planId || "updated"}`;
      default: return Object.entries(data).filter(([key]) => !/digest|token|secret/i.test(key)).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`).join(" · ");
    }
  };
  const labelFor = (kind) => kind.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();
  const updateConversation = (event) => {
    const turn = applyConversationEvent(conversationProjection, event);
    if (!turn) return;
    let view = conversationViews.get(turn.id);
    if (!view && event.kind === "PromptAdmitted") {
      empty.remove();
      const card = document.createElement("article");
      card.className = "conversation-turn";
      const promptLabel = document.createElement("div");
      promptLabel.className = "conversation-label user-label";
      const promptTime = document.createElement("time");
      promptTime.dateTime = turn.promptAt;
      promptTime.textContent = formatFeedTime(turn.promptAt);
      promptLabel.append("YOU", promptTime);
      const promptText = document.createElement("div");
      promptText.className = "conversation-prompt";
      promptText.textContent = turn.prompt;
      const answerHeader = document.createElement("div");
      answerHeader.className = "conversation-answer-header";
      const answerLabel = document.createElement("div");
      answerLabel.className = "conversation-label assistant-label";
      answerLabel.textContent = "FINLEET";
      const answerTime = document.createElement("time");
      answerTime.className = "answer-time";
      const status = document.createElement("span");
      status.className = "conversation-status";
      const answer = document.createElement("div");
      answer.className = "conversation-answer";
      const activity = document.createElement("details");
      activity.className = "turn-activity";
      const activitySummary = document.createElement("summary");
      const activityRows = document.createElement("div");
      activityRows.className = "turn-activity-rows";
      activity.append(activitySummary, activityRows);
      const truncated = document.createElement("small");
      truncated.className = "conversation-truncated";
      answerHeader.append(answerLabel, answerTime, status);
      card.append(promptLabel, promptText, answerHeader, answer, activity, truncated);
      conversation.append(card);
      view = { card, status, answer, answerTime, activity, activitySummary, activityRows, truncated };
      conversationViews.set(turn.id, view);
      for (const [id, oldView] of conversationViews) {
        if (!conversationProjection.turns.some((item) => item.id === id)) {
          oldView.card.remove();
          conversationViews.delete(id);
        }
      }
    }
    if (!view) return;
    view.status.textContent = turn.status.toUpperCase();
    view.answerTime.dateTime = turn.responseAt || turn.promptAt;
    view.answerTime.textContent = formatFeedTime(turn.responseAt || turn.promptAt);
    view.status.className = `conversation-status ${turn.status}`;
    view.answer.textContent = turn.response || (turn.status === "completed" ? "No assistant text was returned." : turn.status === "failed" ? feedMode === "raw" ? turn.error || "The run failed." : "Something went wrong. Review the connection or settings, then retry." : "Waiting for response…");
    view.truncated.textContent = turn.truncated ? "Response shortened for display." : "";
    view.activity.hidden = turn.activity.length === 0;
    view.activitySummary.textContent = feedMode === "normal"
      ? `RUN · ${turn.activity.length} steps · ${turn.activity.filter((item) => item.state === "error").length} errors`
      : `${turn.activity.length} steps · ${turn.activity.some((item) => item.state === "running") ? "◌ Working" : "show activity"}`;
    view.activityRows.replaceChildren();
    for (const item of turn.activity) {
      const row = document.createElement("div");
      row.className = `turn-activity-row ${item.state}`;
      const time = document.createElement("time");
      time.dateTime = item.at;
      time.textContent = formatFeedTime(item.at);
      const label = document.createElement("span");
      label.textContent = item.state === "error" ? `${formatFeedTime(item.at)} · Something went wrong. ${item.detail}` : item.state === "running" ? "◌ Working" : "Step complete";
      row.append(time, label);
      view.activityRows.append(row);
    }
    view.activity.open = feedMode === "raw";
  };
  const renderEvent = (event) => {
    if (!event || typeof event.id !== "string" || seen.has(event.id)) return;
    seen.add(event.id);
    if (seen.size > 2500) seen.delete(seen.values().next().value);
    updateConversation(event);
    empty.remove();
    const row = document.createElement("article");
    row.className = "event";
    row.dataset.kind = event.kind || "";
    const at = new Date(event.at);
    const time = document.createElement("time");
    time.className = "event-time";
    time.dateTime = event.at;
    time.textContent = Number.isNaN(at.valueOf()) ? "--:--:--" : at.toLocaleTimeString([], { hour12: false });
    const body = document.createElement("div");
    body.className = "event-body";
    const title = document.createElement("div");
    title.className = "event-title";
    title.textContent = labelFor(event.kind || "Event");
    body.append(title);
    const content = text(detailFor(event));
    if (content) {
      const detail = document.createElement("div");
      detail.className = "event-text";
      detail.textContent = content;
      body.append(detail);
    }
    row.append(time, body);
    stream.append(row);
    eventCount += 1;
    count.textContent = `${eventCount} EVENTS`;
    if (event.kind === "GraphRunStarted" || event.kind === "ProviderTurnStarted" || event.kind === "ToolCalled") setRunning(true, event.kind === "ToolCalled" ? `Using ${event.data?.name || "tool"}` : "Agent is working");
    if (event.kind === "TaskConclusion" || event.kind === "ProviderTurnFailed") setRunning(false, event.kind === "TaskConclusion" ? "Turn complete" : "Turn failed");
  };
  const scheduleRender = () => {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      const conversationNearBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 120;
      for (const event of queuedEvents.splice(0)) renderEvent(event);
      if (stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120) stream.scrollTop = stream.scrollHeight;
      if (conversationNearBottom) conversation.scrollTop = conversation.scrollHeight;
    });
  };
  const setRunning = (running, detail) => {
    active = running;
    runState.textContent = running ? "IN MOTION" : "STANDBY";
    runDetail.textContent = detail;
    runIndicator.textContent = running ? "◌" : "○";
    runIndicator.className = running ? "state-glyph running" : "state-glyph";
    cancel.disabled = !running;
  };
  const failureDetail = (body) => {
    if (typeof body === "string") return body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return "Prompt failed";
    const error = body.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object" && !Array.isArray(error)) {
      const code = typeof error.code === "string" ? error.code : "";
      const message = typeof error.message === "string" ? error.message : "";
      if (code && message) return `${code}: ${message}`;
      if (message) return message;
      if (code) return code;
    }
    return typeof body.message === "string" ? body.message : "Prompt failed";
  };
  const respondPermission = async (request, decision) => {
    const card = permissionCards.get(request.requestId);
    if (card) card.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    try {
      await call("permission.respond", { requestId: request.requestId, decision });
      card?.remove();
      permissionCards.delete(request.requestId);
      if (permissionCards.size === 0) permissions.innerHTML = '<p class="quiet">No action requires review.</p>';
    } catch (error) {
      if (card) { const message = document.createElement("p"); message.textContent = error.message; card.append(message); }
    }
  };
  const showPermission = (request) => {
    if (!request || typeof request.requestId !== "string" || permissionCards.has(request.requestId)) return;
    if (permissionCards.size === 0) permissions.replaceChildren();
    const card = document.createElement("article");
    card.className = "permission-card";
    const title = document.createElement("h3"); title.textContent = request.toolName || "Action requires approval";
    const capability = document.createElement("p"); capability.textContent = request.requiredPermission || "Permission required";
    const scope = document.createElement("p"); scope.className = "scope"; scope.textContent = request.scope || "";
    card.append(title, capability, scope);
    const actions = document.createElement("div"); actions.className = "permission-actions";
    for (const [label, decision] of [["ALLOW ONCE", "allow-once"], ["ALLOW JOB", "allow-job"], ["ALLOW SESSION", "allow-session"], ["REJECT", "reject"]]) {
      const button = document.createElement("button"); button.type = "button"; button.textContent = label;
      if (decision === "reject") button.className = "reject";
      button.addEventListener("click", () => void respondPermission(request, decision));
      actions.append(button);
    }
    card.append(actions); permissions.append(card); permissionCards.set(request.requestId, card);
    setRunning(true, "Waiting for approval");
  };
  const receive = (raw) => {
    let value;
    try { value = JSON.parse(raw); } catch { return; }
    if (value.method === "event.appended" && value.params?.event) { queuedEvents.push(value.params.event); scheduleRender(); return; }
    if (value.method === "permission.requested") { showPermission(value.params); return; }
    const waiting = pending.get(value.id);
    if (!waiting) return;
    pending.delete(value.id);
    if (value.error) waiting.reject(new Error(value.error.message || "Request failed")); else waiting.resolve(value.result);
  };
  const connect = () => {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(`${scheme}//${location.host}/rpc`);
    setConnection("", "CONNECTING");
    socket.addEventListener("open", async () => {
      retry = 0;
      setConnection("connected", "CONNECTED");
      try {
        const result = await call("session.subscribe", { sessionId: config.sessionId });
        if (Array.isArray(result?.events)) { queuedEvents.push(...result.events); scheduleRender(); }
      } catch { socket.close(); }
    });
    socket.addEventListener("message", (event) => receive(event.data));
    socket.addEventListener("close", () => {
      setConnection("failed", "RECONNECTING");
      for (const request of pending.values()) request.reject(new Error("Connection closed"));
      pending.clear();
      if (retry < 8) setTimeout(connect, Math.min(1000 * (2 ** retry++), 15000)); else setConnection("failed", "DISCONNECTED");
    });
    socket.addEventListener("error", () => socket.close());
  };
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const value = prompt.value.trim();
    if (!value || value.length > 512) return;
    const feedCommand = /^\/feed(?:\s+(clean|normal|raw))?$/i.exec(value);
    if (feedCommand) {
      const requested = (feedCommand[1] || "clean").toLowerCase();
      feedMode = requested;
      feedSelect.value = requested;
      localStorage.setItem("finleet.chat-clean.feed", requested);
      document.querySelector(".activity-panel").open = requested === "raw";
      for (const turn of conversationProjection.turns) {
        const view = conversationViews.get(turn.id);
        if (view) view.activity.open = requested === "raw";
      }
      prompt.value = "";
      prompt.style.height = "auto";
      return;
    }
    prompt.value = "";
    prompt.style.height = "auto";
    send.disabled = true;
    setRunning(true, "Prompt queued");
    try {
      const result = await call("prompt.submit", { prompt: value, sessionId: config.sessionId, promptId: crypto.randomUUID(), delivery: "queue" });
      if (result?.exitCode === 2) setRunning(false, failureDetail(result.body));
    } catch (error) { runDetail.textContent = error.message; }
    finally { send.disabled = false; }
  });
  feedSelect.addEventListener("change", () => {
    feedMode = validFeedMode(feedSelect.value) ? feedSelect.value : "clean";
    localStorage.setItem("finleet.chat-clean.feed", feedMode);
    document.querySelector(".activity-panel").open = feedMode === "raw";
    for (const turn of conversationProjection.turns) {
      const view = conversationViews.get(turn.id);
      if (view) {
        view.activity.open = feedMode === "raw";
        view.activitySummary.textContent = feedMode === "normal" ? `RUN · ${turn.activity.length} steps · ${turn.activity.filter((item) => item.state === "error").length} errors` : `${turn.activity.length} steps · ${turn.activity.some((item) => item.state === "running") ? "◌ Working" : "show activity"}`;
        for (const [index, row] of [...view.activityRows.children].entries()) {
          const item = turn.activity[index];
          const label = row.lastElementChild;
          if (item && label) label.textContent = feedMode === "normal" ? `Step ${index + 1} ${item.state === "error" ? "needs attention" : item.state === "running" ? "in progress" : "complete"}` : item.state === "error" ? `${formatFeedTime(item.at)} · Something went wrong. ${item.detail}` : item.state === "running" ? "◌ Working" : "Step complete";
        }
      }
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.ctrlKey && event.key.toLowerCase() === "o") {
      event.preventDefault();
      const panel = document.querySelector(".activity-panel");
      panel.open = !panel.open;
    }
  });
  prompt.addEventListener("input", () => { prompt.style.height = "auto"; prompt.style.height = `${Math.min(prompt.scrollHeight, 110)}px`; });
  prompt.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
  cancel.addEventListener("click", async () => { try { await call("run.cancel", { sessionId: config.sessionId }); setRunning(false, "Cancellation requested"); } catch (error) { runDetail.textContent = error.message; } });
  connect();
})();
