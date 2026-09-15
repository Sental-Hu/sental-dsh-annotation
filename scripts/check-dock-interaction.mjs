import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Exercise the shipped component and document listeners with a small hook host.
const hooks = [];
let cursor = 0;
let effects = [];
const listeners = new Map();
const react = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity),
  }),
  useState(initial) {
    const slot = cursor++;
    if (!(slot in hooks)) hooks[slot] = initial;
    return [
      hooks[slot],
      (next) => {
        hooks[slot] = typeof next === "function" ? next(hooks[slot]) : next;
      },
    ];
  },
  useRef(initial) {
    const slot = cursor++;
    return (hooks[slot] ??= { current: initial });
  },
  useMemo(factory) {
    return factory();
  },
  useSyncExternalStore(_subscribe, snapshot) {
    return snapshot();
  },
  useEffect(effect, deps) {
    const slot = cursor++;
    const previous = hooks[slot];
    if (
      !previous ||
      deps.some((value, index) => value !== previous.deps[index])
    ) {
      effects.push(() => {
        previous?.cleanup?.();
        hooks[slot] = { deps, cleanup: effect() };
      });
    }
  },
};
let component;
const document = {
  querySelector: () => ({ textContent: "" }),
  querySelectorAll: () => [],
  activeElement: null,
  addEventListener(type, fn) {
    const set = listeners.get(type) ?? new Set();
    set.add(fn);
    listeners.set(type, set);
  },
  removeEventListener(type, fn) {
    listeners.get(type)?.delete(fn);
  },
};
const context = vm.createContext({
  Error,
  document,
  window: {
    innerWidth: 1100,
    innerHeight: 800,
    __ModuleLoader__: {
      load({ factory }) {
        component = factory((id) => {
          assert.equal(id, "react");
          return react;
        }).AnnotationDock;
      },
    },
  },
  console,
});
vm.runInContext(
  readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"),
  context,
);
const annotation = {
  id: "a",
  sessionId: "s",
  messageId: "m",
  status: "pending",
  comment: "原有批注",
  quote: "被选中的原文",
  color: "amber",
  order: 2,
  version: "1",
  createdAt: "2026",
  anchor: {},
};
const snapshot = { status: "ready", annotations: [annotation], revision: "1" };
const props = {
  session: { sessionId: "s" },
  input: { draft: "不能丢失的输入草稿", occurrences: [] },
  insertAnnotationReference() {
    throw new Error("Direct send must not insert a reference");
  },
  sendAnnotation: async (saved) => {
    assert.equal(saved.comment, "修改中的草稿");
    snapshot.annotations = [{ ...saved, status: "sent", sentAt: "2026-09-14" }];
  },
  store: {
    subscribe() {
      return () => {};
    },
    getSnapshot: () => snapshot,
    setSession() {},
    load: async () => {},
    delete: async (id) => {
      snapshot.annotations = snapshot.annotations.filter(
        (item) => item.id !== id,
      );
    },
    update: async (id, patch) => {
      assert.equal(id, "a");
      const updated = {
        ...snapshot.annotations[0],
        comment: patch.comment,
        version: "2",
      };
      snapshot.annotations = [updated];
      return updated;
    },
  },
};
let tree;
function render() {
  for (let i = 0; i < 2; i++) {
    cursor = 0;
    effects = [];
    tree = component(props);
    for (const effect of effects) effect();
  }
}
function find(predicate, node = tree) {
  if (!node || typeof node !== "object") return;
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const found = find(predicate, child);
    if (found) return found;
  }
}
function hasText(node, text) {
  return node?.children?.some(
    (child) =>
      child === text || (typeof child === "object" && hasText(child, text)),
  );
}
function clickText(text) {
  const node = find((n) => n.type === "button" && hasText(n, text));
  assert.ok(node, `button ${text}`);
  node.props.onClick({ stopPropagation() {} });
  render();
}
function dispatch(type, event) {
  for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  render();
}
function detail() {
  return find((n) => n.type === "article");
}
render();
clickText("批注 3");
assert.ok(detail());
dispatch("pointerdown", { target: { closest: () => null } });
assert.equal(detail(), undefined);
clickText("批注 3");
dispatch("pointerdown", { target: { closest: () => ({}) } });
assert.ok(detail());
dispatch("keydown", { key: "Escape", isComposing: false });
assert.equal(detail(), undefined);
clickText("批注 3");
clickText("编辑");
find((n) => n.type === "textarea").props.onChange({
  target: { value: "修改中的草稿" },
});
render();
dispatch("pointerdown", { target: { closest: () => null } });
assert.equal(detail(), undefined);
clickText("继续编辑批注");
assert.equal(find((n) => n.type === "textarea").props.value, "修改中的草稿");
assert.ok(find((n) => n.type === "button" && hasText(n, "保存")));
clickText("发送");
await new Promise((resolve) => setTimeout(resolve, 0));
render();
assert.equal(props.input.draft, "不能丢失的输入草稿");
assert.equal(
  find((n) => n.type === "textarea"),
  undefined,
);
assert.equal(
  find((n) => n.props.className === "dsh-annotation-history-wrap"),
  undefined,
);
clickText("批注 3");
assert.ok(detail());
clickText("编辑");
assert.equal(
  find((n) => n.type === "button" && hasText(n, "已发送")).props.disabled,
  true,
);
find((n) => n.type === "textarea").props.onChange({
  target: { value: "发送后的修改" },
});
render();
clickText("保存");
await new Promise((resolve) => setTimeout(resolve, 0));
render();
assert.equal(snapshot.annotations[0].comment, "发送后的修改");
assert.equal(snapshot.annotations[0].status, "sent");
if (!detail()) clickText("批注 3");
clickText("删除");
await new Promise((resolve) => setTimeout(resolve, 0));
render();
assert.equal(snapshot.annotations.length, 0);
assert.equal(
  find((n) => n.props.role === "tab"),
  undefined,
);
console.log(
  "PASS: sent annotations remain editable and deletable in unified tabs; direct resend is disabled.",
);
// Reopen an unsent item and make the send transport fail. The editor must
// retain the already-saved record, rather than creating a duplicate on retry.
snapshot.annotations = [{ ...annotation, comment: "原有批注" }];
props.sendAnnotation = async () => {
  throw new Error("网络连接中断");
};
render();
clickText("批注 3");
clickText("编辑");
clickText("发送");
await new Promise((resolve) => setTimeout(resolve, 0));
render();
assert.equal(snapshot.annotations.length, 1);
assert.equal(find((n) => n.type === "textarea").props.value, "原有批注");
assert.ok(
  find(
    (n) => n.props.role === "alert" && hasText(n, "批注已保存。网络连接中断"),
  ),
);
assert.equal(props.input.draft, "不能丢失的输入草稿");
console.log(
  "PASS: failed send keeps the saved annotation, error, and unrelated input draft.",
);
// Continue the existing dismissal regression from a visible editor.
dispatch("keydown", { key: "Escape", isComposing: true });
assert.ok(detail());
dispatch("keydown", { key: "Escape", isComposing: false });
assert.equal(detail(), undefined);
// This draft was saved before sending failed, so Escape may close it.
console.log(
  "PASS: built dock opens, dismisses outside/Escape, keeps inside clicks and IME safe, restores edited drafts.",
);
