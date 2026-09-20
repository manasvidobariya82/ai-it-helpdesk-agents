"use client";

import { useState, useTransition } from "react";
import type { Staff, TicketListRow } from "@hd/core";
import { bulkAssign, bulkStatus } from "./queue-actions";

export interface QueueRow extends TicketListRow {
  sla_state: "on_track" | "due_soon" | "breached" | "met" | "none" | "paused";
  sla_label: string;
  threshold: number;
  cost_usd: number | null;
}

/**
 * `businessId` is deliberately absent from these props.
 *
 * It used to be handed to the client and sent back with every bulk action,
 * which made the tenant a value the browser controlled. The server actions
 * read it from the session instead, so there is nothing here for a devtools
 * console to edit.
 */
export function QueueTable({
  rows,
  staff,
  canAssign,
  canUpdate,
}: {
  rows: QueueRow[];
  staff: Staff[];
  canAssign: boolean;
  canUpdate: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const run = (fn: () => Promise<unknown>) =>
    startTransition(async () => {
      await fn();
      setSelected(new Set());
    });

  return (
    <>
      {selected.size > 0 && (canAssign || canUpdate) ? (
        <div className="bulk-bar">
          <span>
            <strong>{selected.size}</strong> selected
          </span>
          <select
            disabled={pending || !canAssign}
            hidden={!canAssign}
            defaultValue=""
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              e.target.value = "";
              run(() => bulkAssign([...selected], v === "__unassign" ? null : v));
            }}
          >
            <option value="">Assign to…</option>
            <option value="__unassign">Unassign (agent owns it)</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.full_name}
              </option>
            ))}
          </select>
          <select
            disabled={pending || !canUpdate}
            hidden={!canUpdate}
            defaultValue=""
            onChange={(e) => {
              const v = e.target.value as "" | "in_progress" | "resolved" | "closed";
              if (!v) return;
              e.target.value = "";
              run(() => bulkStatus([...selected], v));
            }}
          >
            <option value="">Set status…</option>
            <option value="in_progress">In progress</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </select>
          <button disabled={pending} onClick={() => setSelected(new Set())}>
            Clear
          </button>
          {pending ? <span className="sub">working…</span> : null}
        </div>
      ) : null}

      <div className="panel">
        {rows.length === 0 ? (
          <div className="empty">
            Nothing here. Drop a <code>.eml</code> into <code>db/seed/inbox/</code>, post to{" "}
            <code>/api/intake/email</code>, or use the portal form at <code>/portal/new</code>.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th style={{ width: 28 }}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={() =>
                      setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
                    }
                    aria-label="Select all"
                  />
                </th>
                <th>Pri</th>
                <th>Subject</th>
                <th>Requester</th>
                <th>Category</th>
                <th>Confidence</th>
                <th>SLA</th>
                <th>Path</th>
                <th>Owner</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <Row
                  key={t.id}
                  t={t}
                  checked={selected.has(t.id)}
                  onToggle={() => toggle(t.id)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Row({
  t,
  checked,
  onToggle,
}: {
  t: QueueRow;
  checked: boolean;
  onToggle: () => void;
}) {
  const conf = t.triage_confidence;
  const above = conf !== null && conf >= t.threshold;

  return (
    <tr className={checked ? "selected" : undefined}>
      <td>
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          aria-label={`Select ${t.subject}`}
        />
      </td>
      <td>
        <span className={`chip ${(t.priority ?? "p4").toLowerCase()}`}>
          {t.priority ?? "—"}
        </span>
      </td>
      <td>
        <a href={`/tickets/${t.id}`} className="subject-row">
          <span className="subject">
            {t.subject}
            {t.injection_suspected ? (
              <span className="chip p1" title="Injection scanner tripped">
                flagged
              </span>
            ) : null}
          </span>
          <span className="snippet">{t.body.slice(0, 110).replace(/\s+/g, " ")}</span>
        </a>
      </td>
      <td>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span>{t.requester_name ?? t.requester_email ?? "unknown"}</span>
          {t.requester_vip ? <span className="chip vip">VIP</span> : null}
        </div>
      </td>
      <td>
        <div>{t.category ?? <span className="sub">untriaged</span>}</div>
        {t.subcategory ? <div className="sub">{t.subcategory}</div> : null}
      </td>
      <td>
        {conf === null ? (
          <span className="sub">—</span>
        ) : (
          <div className={`conf ${above ? "above" : "below"}`}>
            <span className="conf-bar">
              <i style={{ width: `${Math.round(conf * 100)}%` }} />
            </span>
            {conf.toFixed(2)}
          </div>
        )}
      </td>
      <td>
        <span className={`sla sla-${t.sla_state}`}>{t.sla_label}</span>
      </td>
      <td>
        <span className={`path ${t.resolution_path ?? ""}`}>
          {t.resolution_path ?? "—"}
        </span>
        <div className="sub">{t.status}</div>
      </td>
      <td className="sub">{t.assignee_name ?? "agent"}</td>
    </tr>
  );
}
