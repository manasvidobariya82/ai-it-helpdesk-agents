import { env } from "@hd/core";
import { kbStats, listKbDocuments } from "@hd/rag";
import { currentTenant, fmtDate } from "../../../lib/tenant";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  const tenant = await currentTenant("/knowledge");
  const { ctx } = tenant;

  const [stats, docs] = await Promise.all([
    kbStats(ctx),
    listKbDocuments(ctx),
  ]);

  const totalChunks = stats.reduce((n, s) => n + s.chunks, 0);
  const live = stats.reduce((n, s) => n + s.chunks - s.superseded, 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Knowledge base</h1>
          <div className="sub">
            {live} retrievable chunks of {totalChunks} · embedder{" "}
            <code>{env.EMBEDDING_PROVIDER}</code>
          </div>
        </div>
      </div>

      {env.EMBEDDING_PROVIDER === "hash" ? (
        <div className="mode-banner mode-shadow">
          <strong>dev embedder</strong>
          <span>
            <code>EMBEDDING_PROVIDER=hash</code> is lexical, not semantic. It is
            deterministic and free, which makes it right for local development and
            wrong for production retrieval quality.
          </span>
        </div>
      ) : null}

      <div className="stat-grid">
        {stats.map((s) => (
          <div className="stat" key={s.origin}>
            <div className="label">{s.origin.replace(/_/g, " ")}</div>
            <div className="value">{s.documents}</div>
            <div className="note">
              {s.chunks} chunks
              {s.superseded > 0 ? `, ${s.superseded} superseded` : ""}
            </div>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Documents</h2>
          <span className="sub">
            resolved tickets are written back here after the follow-up check
          </span>
        </div>
        {docs.length === 0 ? (
          <div className="empty">
            Nothing ingested. Run <code>npm run kb:ingest</code>.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Title</th>
                <th>Origin</th>
                <th>Categories</th>
                <th>Chunks</th>
                <th>Added</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td className="subject">{d.title}</td>
                  <td>
                    <span className="chip">{d.origin.replace(/_/g, " ")}</span>
                  </td>
                  <td className="sub">{d.categories.join(", ") || "—"}</td>
                  <td className="num">
                    {d.chunks - d.superseded}
                    {d.superseded > 0 ? (
                      <span className="sub"> (+{d.superseded} old)</span>
                    ) : null}
                  </td>
                  <td className="sub">{fmtDate(d.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
