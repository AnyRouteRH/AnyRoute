import PageFrame from "../../components/PageFrame";
import Ask from "../../components/Ask";

export const metadata = { title: "Ask your files — Anyroute", description: "Drop in documents and ask a question. Files are read in your browser and sent over TLS; the answer cites the passages it used, and every call has a signed receipt." };

export default function AskPage() {
  return (
    <PageFrame>
      <main className="page-main" id="content">
        <div className="page-title" data-reveal>
          <span className="eyebrow">ASK / YOUR FILES</span>
          <h1>
            Ask your
            <br />
            files.
          </h1>
          <p>Drop in documents, ask a question, and get an answer that cites the passages it used. Your files are read in this browser and sent to Anyroute over TLS with your question. This page saves nothing in your browser.</p>
        </div>
        <Ask />
      </main>
    </PageFrame>
  );
}
