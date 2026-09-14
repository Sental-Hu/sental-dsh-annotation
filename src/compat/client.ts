import {
  AnnotationDock,
  type AnnotationDockProps,
} from "../client/AnnotationDock.js";
import type { SelectionSessionLike } from "../client/selection.js";

type Chat = NonNullable<SelectionSessionLike["chat"]>;
type DockProps = AnnotationDockProps & {
  readonly useChat?: <T>(select: (chat: Chat) => T) => T;
};

/** DSH moved chat out of SessionSnapshot into a public selector hook.
 * Keep hook ownership in a separate component so a capability change mounts
 * a new component instead of changing the hooks called by an existing one. */
function HookDock(props: DockProps): unknown {
  const chat = props.useChat!((value) => value);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react") as {
    createElement(type: unknown, props: unknown): unknown;
    useMemo<T>(factory: () => T, deps: readonly unknown[]): T;
  };
  const session = React.useMemo(
    () => ({ ...props.session, chat }),
    [props.session, chat],
  );
  return React.createElement(AnnotationDock, { ...props, session });
}

function DockAdapter(props: DockProps): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react") as {
    createElement(
      type: unknown,
      props: unknown,
      ...children: unknown[]
    ): unknown;
  };
  if (!props.session?.sessionId || !props.input)
    return React.createElement(
      "div",
      { role: "status" },
      "批注暂不可用：DSH 未提供会话或输入接口，请更新批注插件。",
    );
  return React.createElement(
    typeof props.useChat === "function" ? HookDock : AnnotationDock,
    props,
  );
}

// Localize render failures to the plugin, keeping the host conversation usable.
let boundary: unknown;
export function CompatibleAnnotationDock(props: DockProps): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react") as {
    Component: new (props: { children?: unknown }) => {
      props: { children?: unknown };
      state: { failed: boolean };
    };
    createElement(
      type: unknown,
      props: unknown,
      ...children: unknown[]
    ): unknown;
  };
  boundary ??= class extends React.Component {
    state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    render() {
      return this.state.failed
        ? React.createElement(
            "div",
            { role: "alert" },
            "批注界面暂不可用，已有数据保留。请更新批注插件后重新打开会话。",
          )
        : this.props.children;
    }
  };
  return React.createElement(
    boundary,
    { key: props.session?.sessionId },
    React.createElement(DockAdapter, props),
  );
}
