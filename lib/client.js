/**
 * Browser half of dsh-privacy-shield.
 *
 * A compact composer chip that calls the same `/privacy on|off|status`
 * commands as the text interface. It deliberately does not resolve tokens:
 * the chip only toggles the host-side masking state.
 */
window.__ModuleLoader__.load({
  id: "dsh-privacy-shield",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");

    const CSS = [
      ".dshps-chip{display:inline-flex;align-items:center;gap:6px;margin:0 4px;",
      "border:.5px solid var(--dsw-alias-border-l2,rgb(0 0 0 / 14%));border-radius:999px;",
      "padding:5px 10px;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;",
      "background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);",
      "font-family:inherit;touch-action:manipulation}",
      ".dshps-chip[data-on=\"false\"]{color:var(--dsw-alias-label-secondary,#6b7280)}",
      ".dshps-chip:disabled{opacity:.55;cursor:default}",
      ".dshps-chip .dshps-dot{width:7px;height:7px;border-radius:50%;background:#16a34a;flex:none}",
      ".dshps-chip[data-on=\"false\"] .dshps-dot{background:#9ca3af}",
    ].join("");

    function resultText(response) {
      if (!response || response.ok !== true) return "";
      const value = response.value;
      if (!value || !value.result || typeof value.result.text !== "string") return "";
      return value.result.text;
    }

    function PrivacyChip({ privacy }) {
      const [enabled, setEnabled] = React.useState(true);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      React.useEffect(() => {
        let alive = true;
        privacy.status().then((response) => {
          if (!alive) return;
          const match = /session .*: (ON|OFF)/.exec(resultText(response));
          if (match) setEnabled(match[1] === "ON");
        }).catch(() => {});
        return () => { alive = false; };
      }, []);

      const click = () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        const next = !enabled;
        privacy.run(next).then((response) => {
          if (response && response.ok === true) {
            setEnabled(next);
          } else {
            setError((response && response.error && response.error.message) || "command failed");
          }
        }, (reason) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        }).finally(() => setBusy(false));
      };

      return React.createElement("button", {
        type: "button",
        className: "dshps-chip",
        "data-on": enabled ? "true" : "false",
        disabled: busy,
        title: error || (enabled
          ? "Privacy Shield is ON for this session — click to turn it off (/privacy off)"
          : "Privacy Shield is OFF for this session — click to turn it on (/privacy on)"),
        onClick: click,
      }, [
        React.createElement("span", { className: "dshps-dot", "aria-hidden": true, key: "dot" }),
        React.createElement("span", { key: "label" }, enabled ? "Privacy ON" : "Privacy OFF"),
      ]);
    }

    function apply(ctx) {
      if (typeof document !== "undefined" && document.head) {
        ctx.effect(() => {
          const style = document.createElement("style");
          style.dataset.dshPrivacyShield = "1";
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => style.remove();
        }, "privacy-shield: client styles");
      }
      if (!ctx.slots || typeof ctx.slots.inject !== "function") return;
      ctx.slots.inject("conversation.input.plan", () => ctx.slots.register({
        name: "conversation.input.plan",
        id: "privacy-shield",
        inject: (sessionId) => ({
          privacy: {
            sessionId,
            status: () => ctx.remote.commands.execute(sessionId, "/privacy status", []),
            run: (enabled) => ctx.remote.commands.execute(sessionId, enabled ? "/privacy on" : "/privacy off", []),
          },
        }),
      }, PrivacyChip));
    }

    exports.name = "dsh-privacy-shield";
    exports.inject = ["slots", "remote"];
    exports.apply = apply;
    return module.exports;
  },
});
