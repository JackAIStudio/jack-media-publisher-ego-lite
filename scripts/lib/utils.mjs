/**
 * Ego Lite 跨平台复用辅助工具：
 * 严禁包含任何点击最终发布 / 定时发布按钮的逻辑。
 */

export async function bringToFront(page) {
  await page.cdp("Page.bringToFront").catch(() => {});
  await page.waitForTimeout(200);
}

/**
 * 将页面内所有 <video>/<audio>（含 wujie-app shadowRoot）设为静音并暂停。
 * 遵循规范：不修改 volume。
 */
export async function muteAndPausePage(page) {
  return page
    .evaluate(() => {
      const visit = (root) => {
        let count = 0;
        for (const m of root.querySelectorAll("video, audio")) {
          m.muted = true;
          try {
            m.pause();
          } catch {}
          count++;
        }
        const w = root.querySelector?.("wujie-app");
        if (w?.shadowRoot) count += visit(w.shadowRoot);
        return count;
      };
      return visit(document);
    })
    .catch(() => 0);
}

/**
 * 交接前恢复媒体：保持 paused = true，同时恢复 muted = false（不改 volume）。
 */
export async function restorePausedUnmuted(page) {
  return page
    .evaluate(() => {
      const visit = (root) => {
        const list = [];
        for (const m of root.querySelectorAll("video, audio")) {
          try {
            m.pause();
          } catch {}
          m.muted = false;
          list.push({ tag: m.tagName, paused: m.paused, muted: m.muted, volume: m.volume });
        }
        const w = root.querySelector?.("wujie-app");
        if (w?.shadowRoot) list.push(...visit(w.shadowRoot));
        return list;
      };
      return visit(document);
    })
    .catch(() => []);
}

/**
 * 失败时采集极轻量 DOM 诊断信息（不截图、不打印整页 snapshot），
 * 供 Agent 接手兜底时立刻看清现场。
 */
export async function collectLightDiagnostics(page, inWujie = false) {
  return page
    .evaluate((useWujie) => {
      const root = useWujie ? document.querySelector("wujie-app")?.shadowRoot || document : document;
      const bodyEl = root.body || root;
      const text = (bodyEl?.innerText || "").replace(/\s+/g, " ");
      const visibleModals = [
        ...root.querySelectorAll(
          '.d-modal, .semi-modal, .bcc-dialog, .weui-desktop-dialog, [role="dialog"]'
        ),
      ]
        .filter((el) => el.getBoundingClientRect().height > 60)
        .map((el) => (el.innerText || "").replace(/\s+/g, " ").slice(0, 180));
      return {
        url: location.href,
        title: document.title,
        hasWujieShadow: !!document.querySelector("wujie-app")?.shadowRoot,
        visibleModals: visibleModals.slice(0, 3),
        textHead: text.slice(0, 260),
      };
    }, inWujie)
    .catch((e) => ({ diagError: e.message }));
}

export function makeFallback(step, err, diagnostics = null, partial = {}) {
  return {
    status: "needs_agent_fallback",
    failedStep: step,
    reason: err instanceof Error ? err.message : String(err),
    diagnostics,
    ...partial,
  };
}

export function makeHandoff(step, reason, details = {}) {
  return {
    status: "needs_user_handoff",
    failedStep: step,
    reason,
    ...details,
  };
}
