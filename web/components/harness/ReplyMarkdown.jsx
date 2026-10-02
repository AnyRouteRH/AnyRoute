"use client";
import Markdown from "../Markdown";
import CodeBlock from "./CodeBlock";

const renderCode = (block) => <CodeBlock lang={block.lang} text={block.text} />;

export default function ReplyMarkdown({ text }) {
  return <Markdown text={text} renderCode={renderCode} />;
}
