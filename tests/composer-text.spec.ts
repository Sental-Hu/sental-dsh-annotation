import { describe, expect, it } from "vitest";

import {
  appendToDraft,
  formatAnnotationForDraft,
  formatQuotedText,
} from "../src/client/composer-text.js";

describe("annotation composer text", () => {
  it("formats a multi-line selection as a Markdown quote", () => {
    expect(formatQuotedText("第一行\n第二行")).toBe("> 第一行\n> 第二行");
  });

  it("appends a quote after the user's existing draft", () => {
    expect(appendToDraft("已有输入", "> 引用内容")).toBe(
      "已有输入\n\n> 引用内容",
    );
  });

  it("formats one reusable annotation without an internal batch marker", () => {
    expect(
      formatAnnotationForDraft({ quote: "原文", comment: "这里需要改" }),
    ).toBe("> 原文\n> \n> 批注：这里需要改");
  });
});
