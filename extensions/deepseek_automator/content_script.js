/**
 * DeepSeek AI Web Automator - Injected Content Script.
 * Runs inside https://chat.deepseek.com/*
 * - Auto-detects and controls DeepThink (R1) & Smart Search toggles.
 * - Snapshots chat state to guarantee it never returns stale or previous messages.
 * - Injects prompt into the input field and verifies React/Vue updates.
 * - Triggers send via button click or Enter key and verifies input clearing.
 * - Accurately monitors MutationObserver for response completion and returns valid text.
 * - Reports true errors so fake or placeholder data is never generated.
 */

(function () {
  if (window.__DEEPSEEK_AUTOMATOR_INJECTED__) {
    console.log("[DeepSeek Automator] Content script runtime already active in tab.");
    return;
  }
  window.__DEEPSEEK_AUTOMATOR_INJECTED__ = true;

  console.log("%c[DeepSeek Automator] Injected runtime active.", "background: #1e293b; color: #38bdf8; font-weight: bold; padding: 4px;");

  // Keep background service worker alive and register tab
  let keepAlivePort = null;
  function connectKeepAlivePort() {
    try {
      keepAlivePort = chrome.runtime.connect({ name: "deepseek_keepalive_port" });
      keepAlivePort.onDisconnect.addListener(() => {
        keepAlivePort = null;
        setTimeout(connectKeepAlivePort, 2000);
      });
    } catch (e) {
      setTimeout(connectKeepAlivePort, 3000);
    }
  }
  connectKeepAlivePort();

  // Inform background worker that content script is mounted
  chrome.runtime.sendMessage({ type: "CONTENT_SCRIPT_MOUNTED" }).catch(() => {});

  // Re-announce on visibility change
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      chrome.runtime.sendMessage({ type: "CONTENT_SCRIPT_MOUNTED" }).catch(() => {});
      if (!keepAlivePort) connectKeepAlivePort();
    }
  });

  // Listen for prompt execution commands from background service worker
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === "PING") {
      sendResponse({ status: "pong", version: "1.0.0", url: window.location.href });
      return true;
    }

    if (request.type === "EXECUTE_PROMPT") {
      executePromptSequence(
        request.prompt,
        request.raw_id,
        request.is_custom,
        Boolean(request.enable_websearch),
        request.bypass_deepthink !== false
      )
        .then((resultText) => {
          chrome.runtime.sendMessage({
            type: "PROMPT_COMPLETED",
            raw_id: request.raw_id,
            result_text: resultText,
            is_custom: request.is_custom
          }).catch(() => {});
        })
        .catch((err) => {
          console.error("[DeepSeek Automator] Execution failed:", err);
          chrome.runtime.sendMessage({
            type: "DEEPSEEK_ERROR",
            raw_id: request.raw_id,
            error: err.message,
            is_custom: request.is_custom
          }).catch(() => {});
        });

      sendResponse({ status: "executing" });
      return true;
    }
  });

  /**
   * Main Prompt Injection Sequence
   */
  async function executePromptSequence(promptText, rawId, isCustom, enableWebSearch = false, bypassDeepThink = true) {
    console.log(`[DeepSeek Automator] Starting injection for item [${rawId}] (Length: ${promptText.length} chars, WebSearch: ${enableWebSearch})`);

    // Step 1: Snapshot existing assistant messages to prevent capturing stale/old text
    const existingAssistantMessages = getExistingAssistantMessages();
    const initialAssistantCount = existingAssistantMessages.length;
    console.log(`[DeepSeek Automator] Baseline assistant message count: ${initialAssistantCount}`);

    // Step 2: Manage DeepThink (R1) & Web Search Toggles
    if (bypassDeepThink) {
      disableDeepThinkIfActive();
    }
    // Only toggle web search if explicitly requested (never toggle/click when false)
    if (enableWebSearch) {
      setWebSearchToggle(true);
    }
    await sleep(200);

    // Step 3: Locate the input element (textarea)
    const inputElem = await waitForInputElement(6000);
    if (!inputElem) {
      throw new Error("Could not find DeepSeek message input element on chat.deepseek.com.");
    }

    // Step 4: Inject prompt text reliably
    setInputText(inputElem, promptText);
    await sleep(350);

    // Step 5: Send message (button click or Enter key)
    const sendSuccess = await clickSendButton(inputElem);
    if (!sendSuccess) {
      throw new Error("Could not trigger Send or Enter in DeepSeek chat.");
    }

    // Step 6: Verify message was dispatched
    const dispatched = await verifyMessageDispatched(inputElem, 3000);
    if (!dispatched) {
      console.warn("[DeepSeek Automator] Input element did not clear after send attempt, retrying Enter key...");
      dispatchEnterKey(inputElem);
    }

    console.log("[DeepSeek Automator] Prompt dispatched. Waiting for newly generated response...");

    // Step 7: Wait for newly generated response to finish streaming
    const responseText = await waitForNewResponse(initialAssistantCount, existingAssistantMessages, 55000);
    console.log(`[DeepSeek Automator] Completed! Received ${responseText.length} chars.`);
    return responseText;
  }

  /**
   * Snapshot all existing assistant messages in chat DOM
   */
  function getExistingAssistantMessages() {
    const list = [];
    const elements = document.querySelectorAll(
      ".ds-markdown, .chat-message-assistant, div[class*='message-assistant'], .ds-chat-bubble"
    );
    elements.forEach(el => {
      const txt = (el.innerText || el.textContent || "").trim();
      if (txt.length > 5) {
        list.push(txt);
      }
    });
    return list;
  }

  /**
   * Disables DeepThink (R1) if active to prevent 30-60s chain-of-thought latency
   */
  function disableDeepThinkIfActive() {
    try {
      const buttons = Array.from(document.querySelectorAll("button, div[role='button']"));
      const deepThinkBtn = buttons.find(b => b.innerText && b.innerText.includes("DeepThink"));
      
      if (deepThinkBtn) {
        const isSelected = 
          deepThinkBtn.classList.contains("active") || 
          deepThinkBtn.getAttribute("aria-pressed") === "true" ||
          deepThinkBtn.className.includes("primary") ||
          deepThinkBtn.className.includes("selected") ||
          window.getComputedStyle(deepThinkBtn).color.includes("rgb(77, 107, 254)") ||
          window.getComputedStyle(deepThinkBtn).borderColor.includes("rgb(77, 107, 254)");

        if (isSelected) {
          console.log("[DeepSeek Automator] Turning OFF DeepThink to maximize classification speed.");
          deepThinkBtn.click();
        }
      }
    } catch (e) {
      console.warn("[DeepSeek Automator] Error checking DeepThink toggle:", e);
    }
  }

  /**
   * Toggles DeepSeek's Web Search / Smart Search button
   */
  function setWebSearchToggle(enable) {
    // Under no circumstances should the search button be clicked or toggled when search is not requested
    if (!enable) {
      return;
    }

    try {
      const buttons = Array.from(document.querySelectorAll("button, div[role='button']"));
      const searchBtn = buttons.find(b => {
        const txt = (b.innerText || "").trim().toLowerCase();
        const aria = (b.getAttribute("aria-label") || "").toLowerCase();
        const title = (b.title || "").toLowerCase();
        return (
          txt.includes("search") || txt.includes("联网") || 
          aria.includes("search") || aria.includes("web") || 
          title.includes("search") || title.includes("web")
        ) && !txt.includes("deepthink") && !aria.includes("send");
      });

      if (searchBtn) {
        const isSelected = 
          searchBtn.classList.contains("active") || 
          searchBtn.getAttribute("aria-pressed") === "true";

        if (enable && !isSelected) {
          console.log("[DeepSeek Automator] Turning ON Smart Search for fact verification.");
          searchBtn.click();
        }
      }
    } catch (e) {
      console.warn("[DeepSeek Automator] Error toggling WebSearch:", e);
    }
  }

  /**
   * Finds the DeepSeek Chat input area
   */
  async function waitForInputElement(timeoutMs = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const textarea = document.querySelector(
        "textarea#chat-input, textarea[placeholder*='DeepSeek'], textarea[placeholder*='Message'], textarea"
      );
      if (textarea && isVisible(textarea)) return textarea;

      const editable = document.querySelector(
        "div[contenteditable='true'], div[role='textbox']"
      );
      if (editable && isVisible(editable)) return editable;

      await sleep(150);
    }
    return null;
  }

  /**
   * Injects text reliably into React / Vue input component
   */
  function setInputText(elem, text) {
    elem.focus();

    if (elem.tagName.toLowerCase() === "textarea" || elem.tagName.toLowerCase() === "input") {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value"
      )?.set;

      if (nativeSetter) {
        nativeSetter.call(elem, text);
      } else {
        elem.value = text;
      }

      elem.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
      elem.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));

      // Dispatch input event with InputEvent interface for React 18+
      try {
        elem.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: text, bubbles: true }));
      } catch (e) {}
    } else {
      elem.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, text);
      elem.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    }
  }

  /**
   * Dispatches Enter key event on input element as secondary fallback
   */
  function dispatchEnterKey(inputElem) {
    inputElem.focus();
    const eventParams = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true
    };
    inputElem.dispatchEvent(new KeyboardEvent("keydown", eventParams));
    inputElem.dispatchEvent(new KeyboardEvent("keypress", eventParams));
    inputElem.dispatchEvent(new KeyboardEvent("keyup", eventParams));
  }

  /**
   * Locates the active Send button in DeepSeek's DOM
   */
  function findSendButton(inputElem) {
    const isNonSend = (b) => {
      const txt = (b.innerText || "").toLowerCase();
      const aria = (b.getAttribute("aria-label") || "").toLowerCase();
      const title = (b.title || "").toLowerCase();
      const cls = (b.className || "").toString().toLowerCase();
      return (
        txt.includes("search") || txt.includes("web") || txt.includes("联网") || txt.includes("deepthink") ||
        aria.includes("search") || aria.includes("web") || aria.includes("联网") || aria.includes("deepthink") ||
        aria.includes("attach") || aria.includes("upload") || aria.includes("file") || aria.includes("clear") ||
        title.includes("search") || title.includes("web") || title.includes("联网") || title.includes("deepthink") ||
        cls.includes("search")
      );
    };

    // 1. Ascend container hierarchy to find input toolbar
    let container = inputElem.parentElement;
    while (container && container !== document.body) {
      const candidates = Array.from(container.querySelectorAll("button, div[role='button'], .ds-icon-button"));
      
      // Explicit send button match
      for (const b of candidates) {
        if (!isVisible(b) || isNonSend(b)) continue;
        const aria = (b.getAttribute("aria-label") || "").toLowerCase();
        const title = (b.title || "").toLowerCase();
        const type = (b.getAttribute("type") || "").toLowerCase();
        if (aria.includes("send") || title.includes("send") || aria.includes("发送") || title.includes("发送") || type === "submit") {
          return b;
        }
      }

      // Check trailing button with SVG
      const validBtns = candidates.filter(b => isVisible(b) && !isNonSend(b));
      if (validBtns.length > 0) {
        const lastBtn = validBtns[validBtns.length - 1];
        if (lastBtn.querySelector("svg")) {
          return lastBtn;
        }
      }

      container = container.parentElement;
    }

    // 2. Global search for explicit send button
    const globalBtns = Array.from(document.querySelectorAll("button, div[role='button']"));
    for (const b of globalBtns) {
      if (!isVisible(b) || isNonSend(b)) continue;
      const aria = (b.getAttribute("aria-label") || "").toLowerCase();
      const title = (b.title || "").toLowerCase();
      if (aria.includes("send") || title.includes("send") || aria.includes("发送") || title.includes("发送")) {
        return b;
      }
    }

    return null;
  }

  /**
   * Clicks DeepSeek send button as soon as React enables it.
   * Uses a MutationObserver to listen directly for attribute changes (disabled, aria-disabled, class)
   * on the Send button and input toolbar, firing at the exact microsecond React re-renders.
   */
  async function clickSendButton(inputElem) {
    return new Promise((resolve) => {
      let isDone = false;
      let observer = null;
      let timeoutTimer = null;

      function isSendButtonEnabled(btn) {
        if (!btn || !isVisible(btn)) return false;
        const isDisabled = btn.hasAttribute("disabled") ||
                           btn.getAttribute("aria-disabled") === "true" ||
                           btn.classList.contains("disabled");
        return !isDisabled;
      }

      function triggerClick(btn) {
        if (isDone) return;
        isDone = true;
        if (observer) observer.disconnect();
        if (timeoutTimer) clearTimeout(timeoutTimer);

        try {
          btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          btn.click();
        } catch (e) {
          btn.click();
        }
        resolve(true);
      }

      // 1. Immediate check: If button is already enabled, click immediately (0ms delay)
      const immediateBtn = findSendButton(inputElem);
      if (immediateBtn && isSendButtonEnabled(immediateBtn)) {
        triggerClick(immediateBtn);
        return;
      }

      // 2. MutationObserver: Watch the input toolbar for React DOM mutations
      const targetContainer = inputElem.closest("form, div[class*='input'], div[class*='chat'], div[class*='box']") || inputElem.parentElement || document.body;

      observer = new MutationObserver(() => {
        const btn = findSendButton(inputElem);
        if (btn && isSendButtonEnabled(btn)) {
          triggerClick(btn);
        }
      });

      observer.observe(targetContainer, {
        attributes: true,
        attributeFilter: ["disabled", "aria-disabled", "class"],
        childList: true,
        subtree: true
      });

      // 3. Safety timeout fallback (2000ms) in case React doesn't fire an observable mutation
      timeoutTimer = setTimeout(() => {
        if (isDone) return;
        isDone = true;
        if (observer) observer.disconnect();

        const fallbackBtn = findSendButton(inputElem);
        if (fallbackBtn) {
          fallbackBtn.click();
        } else {
          dispatchEnterKey(inputElem);
        }
        resolve(true);
      }, 2000);
    });
  }

  /**
   * Verify whether the prompt was actually accepted (input cleared).
   * Retries clicking if input doesn't clear after 1 second.
   */
  async function verifyMessageDispatched(inputElem, maxWaitMs = 4000) {
    const start = Date.now();
    let retryAttempt = 0;
    while (Date.now() - start < maxWaitMs) {
      const val = (inputElem.value || inputElem.innerText || "").trim();
      if (val === "") {
        return true;
      }
      if (Date.now() - start > 800 * (retryAttempt + 1)) {
        retryAttempt++;
        console.log(`[DeepSeek Automator] Adaptive retry attempt ${retryAttempt} to trigger message dispatch...`);
        const btn = findSendButton(inputElem);
        if (btn && !btn.hasAttribute("disabled") && btn.getAttribute("aria-disabled") !== "true") {
          btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
          btn.click();
        } else {
          dispatchEnterKey(inputElem);
        }
      }
      await sleep(180);
    }
    return false;
  }

  /**
   * Monitors DeepSeek DOM until a NEW response appears and finishes generation
   */
  function waitForNewResponse(initialCount, existingMessages, timeoutMs = 55000) {
    return new Promise((resolve, reject) => {
      let isStreaming = false;
      let lastMutationTime = Date.now();
      let debounceTimer = null;
      const startTime = Date.now();

      function hasStopButton() {
        const btns = Array.from(document.querySelectorAll("button, div[role='button']"));
        return btns.some(b => {
          const text = (b.innerText || "").toLowerCase();
          const title = (b.title || "").toLowerCase();
          const aria = (b.getAttribute("aria-label") || "").toLowerCase();
          return text.includes("stop") || title.includes("stop") || aria.includes("stop") || text.includes("停止");
        });
      }

      function getLatestNewAssistantText() {
        const elements = Array.from(document.querySelectorAll(
          ".ds-markdown, .chat-message-assistant, div[class*='message-assistant'], .ds-chat-bubble"
        ));

        // Find the last assistant bubble
        for (let i = elements.length - 1; i >= 0; i--) {
          const txt = (elements[i].innerText || elements[i].textContent || "").trim();
          // Ensure it is not one of the pre-existing messages from before this injection
          if (txt.length > 15 && !existingMessages.includes(txt)) {
            return txt;
          }
        }
        return null;
      }

      const observer = new MutationObserver(() => {
        lastMutationTime = Date.now();
        isStreaming = true;

        if (debounceTimer) clearTimeout(debounceTimer);

        // When generation finishes: mutations cease for 1400ms AND stop button is gone
        debounceTimer = setTimeout(() => {
          if (!hasStopButton()) {
            const newContent = getLatestNewAssistantText();
            if (newContent) {
              cleanup();
              resolve(newContent);
            }
          }
        }, 1400);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });

      const pollInterval = setInterval(() => {
        // Timeout check
        if (Date.now() - startTime > timeoutMs) {
          cleanup();
          const currentText = getLatestNewAssistantText();
          if (currentText) {
            resolve(currentText);
          } else {
            reject(new Error("Timeout waiting for DeepSeek to generate response."));
          }
          return;
        }

        // Periodic check when generation halts
        if (isStreaming && !hasStopButton() && (Date.now() - lastMutationTime > 1800)) {
          const newContent = getLatestNewAssistantText();
          if (newContent) {
            cleanup();
            resolve(newContent);
          }
        }
      }, 500);

      function cleanup() {
        observer.disconnect();
        clearInterval(pollInterval);
        if (debounceTimer) clearTimeout(debounceTimer);
      }
    });
  }

  function isVisible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
})();
