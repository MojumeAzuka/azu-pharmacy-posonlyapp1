import Dexie from 'dexie';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://bolybwvzpbhetyedzlmo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJvbHlid3Z6cGJoZXR5ZWR6bG1vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxNjAzNDAsImV4cCI6MjEwNTczNjM0MH0.wwgFXOb7LOxxnlbSf-2CZXRZZ-V-1bIaF_Su87AhFGo';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const db = new Dexie('AzuPharmacyPOS');

// Schema Version 4: Indexed fields for role filtering, customer tracking, and 1-year retention
db.version(4).stores({
  drugs: 'id, name, unitType, costPrice, retailPrice, wholesalePrice, stock, barcode',
  sales: 'id, total, saleType, cashierId, cashierEmail, customerName, customerPhone, createdAt, synced'
});

// Schema Version 5: adds the audit log table used by the administrator
// role. `drugs` records also now carry `deletedAt` / `deletedBy` fields
// for soft-delete + recovery, but those are plain (non-indexed) fields,
// so the `drugs` and `sales` index lists below don't need to change —
// only the new `auditLog` table needed adding.
db.version(5).stores({
  drugs: 'id, name, unitType, costPrice, retailPrice, wholesalePrice, stock, barcode',
  sales: 'id, total, saleType, cashierId, cashierEmail, customerName, customerPhone, createdAt, synced',
  auditLog: 'id, createdAt, synced'
});

// Schema Version 6: adds `synced` to drugs. Sales and the audit log have
// always had a retry mechanism — a failed cloud write leaves `synced: 0`
// locally, and the next reconnect automatically pushes it up. Drugs never
// had this. A drug added while the cloud upsert fails (weak mobile
// signal, a dropped connection, a PWA/service-worker quirk — "Load
// failed" is WebKit's generic network-failure message, not a Supabase
// error) was simply stuck unsynced forever, with no automatic recovery.
// This closes that gap using the exact same pattern sales already use.
db.version(6).stores({
  drugs: 'id, name, unitType, costPrice, retailPrice, wholesalePrice, stock, barcode, synced',
  sales: 'id, total, saleType, cashierId, cashierEmail, customerName, customerPhone, createdAt, synced',
  auditLog: 'id, createdAt, synced'
});

// Schema Version 7:
//  - `sales` gains `reversalPending` (indexed) — a partial reversal is
//    now written locally first and retried against the cloud, the same
//    write-then-sync pattern everything else already uses, instead of
//    silently failing if the cloud update was rejected (e.g. by RLS)
//    or the device was offline.
//  - Two new tables for the attendant/cashier ticket workflow:
//    `tickets` (a cart an attendant built for a customer, pending
//    payment approval by a cashier) and `bankOptions` (the admin-
//    managed list of banks a cashier can record a transfer against).
db.version(7).stores({
  drugs: 'id, name, unitType, costPrice, retailPrice, wholesalePrice, stock, barcode, synced',
  sales: 'id, total, saleType, cashierId, cashierEmail, customerName, customerPhone, createdAt, synced, reversalPending',
  auditLog: 'id, createdAt, synced',
  tickets: 'id, status, attendantId, attendantEmail, cashierId, cashierEmail, createdAt, synced',
  bankOptions: 'id, name, active, synced'
});

// ============================================================
// ROLE HIERARCHY
// administrator > manager > cashier > salesperson. A higher role can
// do everything a lower role can, plus its own extra features. Cashier
// sits between salesperson and manager: a cashier does everything a
// salesperson (attendant) can, PLUS approve/complete pending tickets —
// but doesn't automatically get manager-level inventory/admin rights.
// Managers and administrators, being higher ranked, can also act as a
// cashier (approve tickets) when needed.
// ============================================================
export const ROLE_RANK = {
  salesperson: 0,
  cashier: 1,
  manager: 2,
  administrator: 3
};

export function hasRole(role, minimumRole) {
  return (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[minimumRole] ?? 0);
}

function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

export async function ensureSeedData() {
  const count = await db.drugs.count();
  if (count === 0) {
    await db.drugs.bulkPut([
      { id: '1', name: 'Paracetamol 500mg', unitType: 'Sachet', costPrice: 350, retailPrice: 500, wholesalePrice: 420, stock: 200, barcode: '1001' },
      { id: '2', name: 'Amoxicillin 500mg', unitType: 'Pack', costPrice: 1800, retailPrice: 2500, wholesalePrice: 2100, stock: 50, barcode: '1002' },
      { id: '3', name: 'Arthemeter/Lume 80/480', unitType: 'Pack', costPrice: 2200, retailPrice: 3200, wholesalePrice: 2750, stock: 40, barcode: '1003' },
      { id: '4', name: 'Emzolyn Cough Syrup 100ml', unitType: 'Bottle', costPrice: 1000, retailPrice: 1500, wholesalePrice: 1250, stock: 85, barcode: '1004' },
      { id: '5', name: 'Vitamin C 500mg', unitType: 'Sachet', costPrice: 500, retailPrice: 800, wholesalePrice: 650, stock: 300, barcode: '1005' },
      { id: '6', name: 'Ibuprofen 400mg', unitType: 'Sachet', costPrice: 750, retailPrice: 1200, wholesalePrice: 1000, stock: 120, barcode: '1006' }
    ]);
  }
}

// Disabled — real drug data now lives in Supabase (populated via CSV
// import) and is pulled down by syncDrugsFromCloud() on load. Leaving
// this active would reseed the six sample drugs on any device with an
// empty local database.
// ensureSeedData();

// Supabase/PostgREST caps every request at 1000 rows by default, silently
// — a plain .select('*') on a catalog bigger than that would only ever
// pull the first 1000 drugs, with no error to warn you. This pages
// through the table with .range() until a page comes back short of
// PAGE_SIZE, so the full catalog syncs down regardless of size.
const DRUGS_SYNC_PAGE_SIZE = 1000;

export async function syncDrugsFromCloud() {
  try {
    let allCloudDrugs = [];
    let from = 0;

    while (true) {
      const { data: page, error } = await supabase
        .from('drugs')
        .select('*')
        .range(from, from + DRUGS_SYNC_PAGE_SIZE - 1);

      if (error) throw error;
      if (!page || page.length === 0) break;

      allCloudDrugs = allCloudDrugs.concat(page);

      if (page.length < DRUGS_SYNC_PAGE_SIZE) break;
      from += DRUGS_SYNC_PAGE_SIZE;
    }

    if (allCloudDrugs.length > 0) {
      // Don't let a pull-from-cloud stomp a drug this device just created
      // or edited and hasn't successfully pushed up yet (synced: 0) — a
      // bulkPut here would overwrite it with stale/missing cloud data
      // before syncPendingDrugsToCloud() gets a chance to retry the push.
      const pendingIds = new Set(
        (await db.drugs.where('synced').equals(0).toArray()).map((d) =>
          String(d.id)
        )
      );

      const mappedDrugs = allCloudDrugs
        .filter((drug) => !pendingIds.has(String(drug.id)))
        .map((drug) => ({
          id: String(drug.id),
          name: drug.name,
          unitType: drug.unit_type || drug.unitType || 'Sachet',
          costPrice: Number(drug.cost_price ?? drug.costPrice ?? 0),
          retailPrice: Number(drug.retail_price ?? drug.retailPrice ?? 0),
          wholesalePrice: Number(drug.wholesale_price ?? drug.wholesalePrice ?? 0),
          stock: Number(drug.stock ?? 0),
          barcode: drug.barcode || '',
          halfPackQty:
            drug.half_pack_qty ?? drug.halfPackQty ?? null,
          halfPackPrice:
            drug.half_pack_price ?? drug.halfPackPrice ?? null,
          packQty: drug.pack_qty ?? drug.packQty ?? null,
          packPrice: drug.pack_price ?? drug.packPrice ?? null,
          deletedAt: drug.deleted_at || drug.deletedAt || null,
          deletedBy: drug.deleted_by || drug.deletedBy || null,
          synced: 1
        }));

      if (mappedDrugs.length > 0) {
        await db.drugs.bulkPut(mappedDrugs);
      }
    }
  } catch (err) {
    console.warn('Unable to sync drugs from cloud:', err.message);
  }
}

// Mirrors syncPendingSalesToCloud(): retries the cloud upsert for any
// drug that was saved locally (synced: 0) but whose push to Supabase
// failed at the time — weak signal, a dropped connection, etc. Runs on
// every reconnect/app-load alongside the sales and audit-log retries.
export async function syncPendingDrugsToCloud() {
  try {
    const unsyncedDrugs = await db.drugs.where('synced').equals(0).toArray();
    if (unsyncedDrugs.length === 0) return;

    for (const drug of unsyncedDrugs) {
      const { error } = await supabase.from('drugs').upsert([
        {
          id: drug.id,
          name: drug.name,
          unit_type: drug.unitType,
          cost_price: drug.costPrice,
          retail_price: drug.retailPrice,
          wholesale_price: drug.wholesalePrice,
          stock: drug.stock,
          barcode: drug.barcode,
          half_pack_qty: drug.halfPackQty ?? null,
          half_pack_price: drug.halfPackPrice ?? null,
          pack_qty: drug.packQty ?? null,
          pack_price: drug.packPrice ?? null
        }
      ]);

      if (!error) {
        await db.drugs.update(drug.id, { synced: 1 });
      }
    }
  } catch (err) {
    console.warn('Unable to sync pending drugs:', err.message);
  }
}

export async function syncPendingSalesToCloud() {
  try {
    const unsyncedSales = await db.sales.where('synced').equals(0).toArray();
    if (unsyncedSales.length === 0) return;

    for (const sale of unsyncedSales) {
      const { error } = await supabase.from('sales').insert([
        {
          id: sale.id,
          total: sale.total,
          sale_type: sale.saleType,
          cashier_id: sale.cashierId,
          cashier_email: sale.cashierEmail,
          customer_name: sale.customerName,
          customer_phone: sale.customerPhone,
          items: sale.items,
          created_at: sale.createdAt
        }
      ]);

      if (!error) {
        await db.sales.update(sale.id, { synced: 1 });
      }
    }
  } catch (err) {
    console.warn('Unable to sync pending sales:', err.message);
  }
}

// Automatically purge offline sales older than 1 year (365 days)
export async function pruneSalesOlderThanOneYear() {
  try {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const cutoffDate = oneYearAgo.toISOString();

    const oldSales = await db.sales.where('createdAt').below(cutoffDate).toArray();
    if (oldSales.length > 0) {
      const idsToDelete = oldSales.map((s) => s.id);
      await db.sales.bulkDelete(idsToDelete);
      console.log(`Pruned ${idsToDelete.length} sales records older than 1 year.`);
    }
  } catch (err) {
    console.warn('Error pruning old sales:', err.message);
  }
}

// ============================================================
// AUDIT LOG
// Every sensitive manager/administrator action writes one entry
// here. Written locally first (so it's never lost offline), then
// pushed to Supabase when possible.
// ============================================================
export async function logAuditEvent({ actorEmail, actorRole, action, targetType, targetId, details }) {
  const entry = {
    id: generateId('LOG'),
    actorEmail: actorEmail || 'unknown',
    actorRole: actorRole || 'unknown',
    action,
    targetType: targetType || '',
    targetId: targetId ? String(targetId) : '',
    details: details ? JSON.stringify(details) : '',
    createdAt: new Date().toISOString(),
    synced: 0
  };

  try {
    await db.auditLog.add(entry);
  } catch (err) {
    console.warn('Unable to write audit log entry locally:', err.message);
  }

  if (navigator.onLine) {
    try {
      const { error } = await supabase.from('audit_log').insert([
        {
          id: entry.id,
          actor_email: entry.actorEmail,
          actor_role: entry.actorRole,
          action: entry.action,
          target_type: entry.targetType,
          target_id: entry.targetId,
          details: entry.details ? JSON.parse(entry.details) : null,
          created_at: entry.createdAt
        }
      ]);
      if (!error) {
        await db.auditLog.update(entry.id, { synced: 1 });
      }
    } catch (err) {
      console.warn('Audit log cloud sync deferred:', err.message);
    }
  }

  return entry;
}

export async function syncAuditLogToCloud() {
  try {
    const pending = await db.auditLog.where('synced').equals(0).toArray();
    if (pending.length === 0) return;

    for (const entry of pending) {
      const { error } = await supabase.from('audit_log').insert([
        {
          id: entry.id,
          actor_email: entry.actorEmail,
          actor_role: entry.actorRole,
          action: entry.action,
          target_type: entry.targetType,
          target_id: entry.targetId,
          details: entry.details ? JSON.parse(entry.details) : null,
          created_at: entry.createdAt
        }
      ]);
      if (!error) {
        await db.auditLog.update(entry.id, { synced: 1 });
      }
    }
  } catch (err) {
    console.warn('Unable to sync audit log:', err.message);
  }
}

// ============================================================
// DRUG SOFT-DELETE / RECOVERY (administrator feature)
// A manager's "delete" only sets deletedAt/deletedBy — the row
// stays in place so an administrator can restore it, or remove
// it for good with permanentlyDeleteDrug.
// ============================================================
export async function softDeleteDrug(id, actor) {
  try {
    const drugKey = String(id);
    const existing = (await db.drugs.get(drugKey)) || (await db.drugs.get(Number(id)));
    if (!existing) return;

    const deletedAt = new Date().toISOString();
    const deletedBy = actor?.email || 'unknown';

    await db.drugs.update(existing.id, { deletedAt, deletedBy });

    if (navigator.onLine) {
      try {
        await supabase
          .from('drugs')
          .update({ deleted_at: deletedAt, deleted_by: deletedBy })
          .eq('id', drugKey);
      } catch (err) {
        console.warn('Cloud soft-delete postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'drug_deleted',
      targetType: 'drug',
      targetId: drugKey,
      details: { name: existing.name }
    });
  } catch (err) {
    console.warn('Unable to soft-delete drug:', err.message);
  }
}

export async function restoreDrug(id, actor) {
  try {
    const drugKey = String(id);
    const existing = (await db.drugs.get(drugKey)) || (await db.drugs.get(Number(id)));
    if (!existing) return;

    await db.drugs.update(existing.id, { deletedAt: null, deletedBy: null });

    if (navigator.onLine) {
      try {
        await supabase
          .from('drugs')
          .update({ deleted_at: null, deleted_by: null })
          .eq('id', drugKey);
      } catch (err) {
        console.warn('Cloud restore postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'drug_restored',
      targetType: 'drug',
      targetId: drugKey,
      details: { name: existing.name }
    });
  } catch (err) {
    console.warn('Unable to restore drug:', err.message);
  }
}

export async function permanentlyDeleteDrug(id, actor) {
  try {
    const drugKey = String(id);
    const existing = (await db.drugs.get(drugKey)) || (await db.drugs.get(Number(id)));

    await db.drugs.delete(drugKey);
    await db.drugs.delete(Number(id));

    if (navigator.onLine) {
      try {
        await supabase.from('drugs').delete().eq('id', drugKey);
      } catch (err) {
        console.warn('Cloud permanent delete postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'drug_permanently_deleted',
      targetType: 'drug',
      targetId: drugKey,
      details: { name: existing?.name || 'unknown' }
    });
  } catch (err) {
    console.warn('Unable to permanently delete drug:', err.message);
  }
}

// ============================================================
// BULK SALES-HISTORY DELETION (administrator feature)
// This is a hard delete — sales records are not soft-deletable.
// Double-check this is actually what you want before wiring up
// the confirm dialog, since it's irreversible.
// ============================================================
export async function bulkDeleteSalesByDateRange(startISO, endISO, actor) {
  try {
    const toDelete = await db.sales
      .where('createdAt')
      .between(startISO, endISO, true, true)
      .toArray();

    const ids = toDelete.map((s) => s.id);

    if (ids.length > 0) {
      await db.sales.bulkDelete(ids);
    }

    if (navigator.onLine) {
      try {
        await supabase
          .from('sales')
          .delete()
          .gte('created_at', startISO)
          .lte('created_at', endISO);
      } catch (err) {
        console.warn('Cloud bulk sales delete postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'sales_bulk_deleted',
      targetType: 'sales_range',
      targetId: `${startISO}_to_${endISO}`,
      details: { count: ids.length, startISO, endISO }
    });

    return ids.length;
  } catch (err) {
    console.warn('Unable to bulk-delete sales:', err.message);
    return 0;
  }
}

// ============================================================
// PARTIAL SALE REVERSAL (manager feature)
// Reverses one or more LINE ITEMS from a sale — not the whole sale.
// `reversals` is [{ id: <item id>, quantity: <how many units to
// reverse> }]. Each matching item gets a running `reversedQty` so a
// line can be reversed more than once (e.g. 2 of 5 today, 1 more
// later) without ever reversing more than it originally sold. Stock
// for the affected drugs is restored, the sale's stored total is
// reduced by the refunded amount, and the sale record keeps a
// `reversalLog` of who reversed what and when, for the audit trail.
// ============================================================
export async function reverseSaleItems(sale, reversals, actor) {
  try {
    const saleId = String(sale.id);
    const reversalMap = new Map(
      reversals.map((r) => [String(r.id), Number(r.quantity) || 0])
    );

    let refundTotal = 0;
    const reversedDetails = [];

    const updatedItems = (sale.items || []).map((item) => {
      const reverseQty = reversalMap.get(String(item.id));
      if (!reverseQty || reverseQty <= 0) return item;

      const alreadyReversed = Number(item.reversedQty) || 0;
      const remaining = item.quantity - alreadyReversed;
      const qtyToReverse = Math.min(reverseQty, remaining);
      if (qtyToReverse <= 0) return item;

      // Refund at this item's average per-unit price (its stored
      // lineTotal already reflects any pack discount), so a reversed
      // unit is credited back at what it was actually sold for.
      const perUnitPrice =
        item.quantity > 0
          ? (item.lineTotal ?? item.activePrice * item.quantity) /
            item.quantity
          : item.activePrice || 0;

      const refund = perUnitPrice * qtyToReverse;
      refundTotal += refund;

      reversedDetails.push({
        itemId: item.id,
        name: item.name,
        quantity: qtyToReverse,
        refund,
        reversedBy: actor?.email || 'unknown',
        reversedAt: new Date().toISOString()
      });

      return {
        ...item,
        reversedQty: alreadyReversed + qtyToReverse
      };
    });

    if (reversedDetails.length === 0) {
      return { success: false, reason: 'Nothing to reverse.' };
    }

    const newTotal = Math.max(0, (sale.total || 0) - refundTotal);
    const existingLog = Array.isArray(sale.reversalLog)
      ? sale.reversalLog
      : [];
    const newReversalLog = [...existingLog, ...reversedDetails];

    // Restore stock for each reversed item, locally first.
    for (const detail of reversedDetails) {
      const drugKey = String(detail.itemId);
      const existingDrug =
        (await db.drugs.get(drugKey)) ||
        (await db.drugs.get(Number(detail.itemId)));

      if (existingDrug) {
        const restoredStock =
          (existingDrug.stock || 0) + detail.quantity;

        await db.drugs.update(existingDrug.id, {
          stock: restoredStock,
          synced: 0
        });

        if (navigator.onLine) {
          try {
            await supabase
              .from('drugs')
              .update({ stock: restoredStock })
              .eq('id', drugKey);
            await db.drugs.update(existingDrug.id, { synced: 1 });
          } catch (err) {
            console.warn('Cloud stock restore postponed:', err.message);
          }
        }
      }
    }

    // Persist the reversed sale locally FIRST, unconditionally — not
    // only when this device already had a local copy. Sales History
    // mostly renders from cloudSales (fetched from Supabase), and the
    // merge logic prefers the local copy over the cloud one, so writing
    // locally with `put` (which both creates and updates) is what makes
    // the reversal survive a reload on this device even if the cloud
    // push below fails or is still offline. `reversalPending: 1` marks
    // it for the retry function below.
    await db.sales.put({
      ...sale,
      items: updatedItems,
      total: newTotal,
      reversalLog: newReversalLog,
      reversalPending: 1
    });

    let cloudSynced = false;

    if (navigator.onLine) {
      try {
        const { error: cloudError } = await supabase
          .from('sales')
          .update({
            items: updatedItems,
            total: newTotal,
            reversal_log: newReversalLog
          })
          .eq('id', saleId);

        if (cloudError) throw cloudError;

        cloudSynced = true;
        await db.sales.update(saleId, { reversalPending: 0 });
      } catch (err) {
        console.warn('Cloud sale reversal postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'sale_items_reversed',
      targetType: 'sale',
      targetId: saleId,
      details: { items: reversedDetails, refundTotal }
    });

    return {
      success: true,
      updatedItems,
      newTotal,
      reversalLog: newReversalLog,
      cloudSynced
    };
  } catch (err) {
    console.warn('Unable to reverse sale items:', err.message);
    return { success: false, reason: err.message };
  }
}

// Mirrors syncPendingDrugsToCloud()/syncPendingSalesToCloud(): retries
// pushing a reversal's updated items/total up to Supabase for any sale
// where the cloud push failed or was offline at the time (reversalPending).
export async function syncPendingReversalsToCloud() {
  try {
    const pending = await db.sales
      .where('reversalPending')
      .equals(1)
      .toArray();

    if (pending.length === 0) return;

    for (const sale of pending) {
      const { error } = await supabase
        .from('sales')
        .update({
          items: sale.items,
          total: sale.total,
          reversal_log: sale.reversalLog
        })
        .eq('id', sale.id);

      if (!error) {
        await db.sales.update(sale.id, { reversalPending: 0 });
      }
    }
  } catch (err) {
    console.warn('Unable to sync pending reversals:', err.message);
  }
}

// ============================================================
// ATTENDANT / CASHIER TICKET WORKFLOW
// ------------------------------------------------------------
// DRAFT tickets (an attendant still building a customer's cart) live
// only in React state in App.jsx — they're never written here, so
// there's nothing to sync or clean up for them. A ticket only reaches
// this file once an attendant submits it, at which point it's created
// directly in PENDING_PAYMENT status: printed for the customer to carry
// to the cashier, and visible to every cashier/manager/administrator
// device via fetchCloudTickets(), not just the attendant's own device.
// ============================================================

export async function createTicket(ticketPayload, actor) {
  const ticket = {
    ...ticketPayload,
    id: ticketPayload.id || generateId('TICKET'),
    status: 'PENDING_PAYMENT',
    createdAt: new Date().toISOString(),
    synced: 0
  };

  try {
    await db.tickets.add(ticket);
  } catch (err) {
    console.warn('Unable to write ticket locally:', err.message);
    return { success: false, reason: err.message };
  }

  if (navigator.onLine) {
    try {
      const { error } = await supabase.from('tickets').insert([
        {
          id: ticket.id,
          status: ticket.status,
          items: ticket.items,
          total: ticket.total,
          sale_type: ticket.saleType,
          customer_name: ticket.customerName,
          customer_phone: ticket.customerPhone,
          attendant_id: ticket.attendantId,
          attendant_email: ticket.attendantEmail,
          created_at: ticket.createdAt
        }
      ]);
      if (!error) {
        await db.tickets.update(ticket.id, { synced: 1 });
      }
    } catch (err) {
      console.warn('Cloud ticket creation postponed:', err.message);
    }
  }

  await logAuditEvent({
    actorEmail: actor?.email,
    actorRole: actor?.role,
    action: 'ticket_created',
    targetType: 'ticket',
    targetId: ticket.id,
    details: { total: ticket.total, customerName: ticket.customerName }
  });

  return { success: true, ticket };
}

// Pulls every ticket from the last 2 days down from Supabase, so a
// cashier's queue shows tickets created by ANY attendant on ANY device,
// not just ones submitted from this device. The 2-day window (rather
// than "pending only") also lets a just-approved/cancelled ticket still
// show briefly in a shared "recent tickets" view for cross-checking.
// Same pending-write guard as syncDrugsFromCloud: a ticket this device
// has unsynced local changes for (synced: 0) is never overwritten by a
// stale cloud copy.
export async function fetchCloudTickets() {
  try {
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    const { data, error } = await supabase
      .from('tickets')
      .select('*')
      .gte('created_at', twoDaysAgo.toISOString())
      .order('created_at', { ascending: false });

    if (error) throw error;
    if (!data || data.length === 0) return;

    const pendingIds = new Set(
      (await db.tickets.where('synced').equals(0).toArray()).map((t) =>
        String(t.id)
      )
    );

    const mapped = data
      .filter((t) => !pendingIds.has(String(t.id)))
      .map((t) => ({
        id: String(t.id),
        status: t.status,
        items: t.items || [],
        total: Number(t.total || 0),
        saleType: t.sale_type || 'retail',
        customerName: t.customer_name || '',
        customerPhone: t.customer_phone || '',
        attendantId: t.attendant_id,
        attendantEmail: t.attendant_email,
        cashierId: t.cashier_id || null,
        cashierEmail: t.cashier_email || null,
        paymentMethod: t.payment_method || null,
        saleId: t.sale_id || null,
        createdAt: t.created_at,
        paidAt: t.paid_at || null,
        synced: 1
      }));

    if (mapped.length > 0) {
      await db.tickets.bulkPut(mapped);
    }
  } catch (err) {
    console.warn('Unable to fetch tickets from cloud:', err.message);
  }
}

export async function syncPendingTicketsToCloud() {
  try {
    const pending = await db.tickets.where('synced').equals(0).toArray();
    if (pending.length === 0) return;

    for (const ticket of pending) {
      const { error } = await supabase.from('tickets').upsert([
        {
          id: ticket.id,
          status: ticket.status,
          items: ticket.items,
          total: ticket.total,
          sale_type: ticket.saleType,
          customer_name: ticket.customerName,
          customer_phone: ticket.customerPhone,
          attendant_id: ticket.attendantId,
          attendant_email: ticket.attendantEmail,
          cashier_id: ticket.cashierId || null,
          cashier_email: ticket.cashierEmail || null,
          payment_method: ticket.paymentMethod || null,
          sale_id: ticket.saleId || null,
          created_at: ticket.createdAt,
          paid_at: ticket.paidAt || null
        }
      ]);

      if (!error) {
        await db.tickets.update(ticket.id, { synced: 1 });
      }
    }
  } catch (err) {
    console.warn('Unable to sync pending tickets:', err.message);
  }
}

// A PENDING_PAYMENT ticket older than this with no cashier action is
// treated as abandoned (customer walked off, or never made it to the
// till). This is only checked opportunistically — whenever a device
// loads the Tickets tab — there's no server-side cron doing this, so a
// ticket won't flip to EXPIRED until some device with the app open
// happens to notice. Good enough for a single-location pharmacy; worth
// revisiting if that ever stops being true.
const TICKET_EXPIRY_MINUTES = 30;

export async function expireStaleTickets() {
  try {
    const cutoff = new Date();
    cutoff.setMinutes(cutoff.getMinutes() - TICKET_EXPIRY_MINUTES);

    const pending = await db.tickets
      .where('status')
      .equals('PENDING_PAYMENT')
      .toArray();

    const stale = pending.filter((t) => new Date(t.createdAt) < cutoff);
    if (stale.length === 0) return;

    for (const ticket of stale) {
      await db.tickets.update(ticket.id, {
        status: 'EXPIRED',
        synced: 0
      });

      if (navigator.onLine) {
        try {
          const { error } = await supabase
            .from('tickets')
            .update({ status: 'EXPIRED' })
            .eq('id', ticket.id);
          if (!error) {
            await db.tickets.update(ticket.id, { synced: 1 });
          }
        } catch (err) {
          console.warn('Cloud ticket expiry postponed:', err.message);
        }
      }
    }
  } catch (err) {
    console.warn('Unable to expire stale tickets:', err.message);
  }
}

export async function cancelTicket(ticket, actor) {
  try {
    await db.tickets.update(ticket.id, { status: 'CANCELLED', synced: 0 });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('tickets')
          .update({ status: 'CANCELLED' })
          .eq('id', ticket.id);
        if (!error) {
          await db.tickets.update(ticket.id, { synced: 1 });
        }
      } catch (err) {
        console.warn('Cloud ticket cancel postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'ticket_cancelled',
      targetType: 'ticket',
      targetId: ticket.id,
      details: { total: ticket.total }
    });

    return { success: true };
  } catch (err) {
    console.warn('Unable to cancel ticket:', err.message);
    return { success: false, reason: err.message };
  }
}

// The cashier-approval step: this is where a ticket actually becomes a
// real sale. `paymentBreakdown` is { cash, bank, bankOption, card } —
// whichever of cash/bank/card aren't used are 0. Stock is deducted the
// same way handleCheckout does it for a direct sale, a `sales` row is
// created (so Sales History, the audit log, and the drug-accountability
// search all pick it up for free), and the ticket itself is marked PAID
// with a link back to that sale.
export async function approveTicket(ticket, paymentBreakdown, actor) {
  try {
    const saleId = generateId('SALE');
    const paidAt = new Date().toISOString();

    const saleData = {
      id: saleId,
      total: ticket.total,
      saleType: ticket.saleType,
      cashierId: actor?.id,
      cashierEmail: actor?.email,
      attendantId: ticket.attendantId,
      attendantEmail: ticket.attendantEmail,
      customerName: ticket.customerName,
      customerPhone: ticket.customerPhone,
      items: ticket.items,
      paymentMethod: paymentBreakdown,
      ticketId: ticket.id,
      createdAt: paidAt,
      synced: 0
    };

    await db.transaction('rw', db.drugs, db.sales, db.tickets, async () => {
      for (const item of ticket.items) {
        if (!item.id) continue;
        const drugKey = String(item.id);
        const existingDrug =
          (await db.drugs.get(drugKey)) || (await db.drugs.get(Number(item.id)));

        if (existingDrug) {
          await db.drugs.update(existingDrug.id, {
            stock: (existingDrug.stock || 0) - item.quantity,
            synced: 0
          });
        }
      }

      await db.sales.add(saleData);

      await db.tickets.update(ticket.id, {
        status: 'PAID',
        cashierId: actor?.id,
        cashierEmail: actor?.email,
        paymentMethod: paymentBreakdown,
        saleId,
        paidAt,
        synced: 0
      });
    });

    if (navigator.onLine) {
      // Push the stock changes, the new sale, and the ticket update to
      // the cloud. Each piece retries independently on the next
      // reconnect (via syncPendingDrugsToCloud / syncPendingSalesToCloud
      // / syncPendingTicketsToCloud) if any of these calls fail here.
      for (const item of ticket.items) {
        if (!item.id) continue;
        const drugKey = String(item.id);
        const existingDrug =
          (await db.drugs.get(drugKey)) || (await db.drugs.get(Number(item.id)));
        if (existingDrug) {
          try {
            const { error } = await supabase
              .from('drugs')
              .update({ stock: existingDrug.stock })
              .eq('id', drugKey);
            if (!error) await db.drugs.update(existingDrug.id, { synced: 1 });
          } catch (err) {
            console.warn('Cloud stock update postponed:', err.message);
          }
        }
      }

      try {
        const { error } = await supabase.from('sales').insert([
          {
            id: saleData.id,
            total: saleData.total,
            sale_type: saleData.saleType,
            cashier_id: saleData.cashierId,
            cashier_email: saleData.cashierEmail,
            attendant_id: saleData.attendantId,
            attendant_email: saleData.attendantEmail,
            customer_name: saleData.customerName,
            customer_phone: saleData.customerPhone,
            items: saleData.items,
            payment_method: saleData.paymentMethod,
            ticket_id: saleData.ticketId,
            created_at: saleData.createdAt
          }
        ]);
        if (!error) await db.sales.update(saleId, { synced: 1 });
      } catch (err) {
        console.warn('Cloud sale insert postponed:', err.message);
      }

      try {
        const { error } = await supabase
          .from('tickets')
          .update({
            status: 'PAID',
            cashier_id: actor?.id,
            cashier_email: actor?.email,
            payment_method: paymentBreakdown,
            sale_id: saleId,
            paid_at: paidAt
          })
          .eq('id', ticket.id);
        if (!error) await db.tickets.update(ticket.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud ticket approval postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'ticket_approved',
      targetType: 'ticket',
      targetId: ticket.id,
      details: { saleId, total: ticket.total, paymentBreakdown }
    });

    return { success: true, sale: saleData };
  } catch (err) {
    console.warn('Unable to approve ticket:', err.message);
    return { success: false, reason: err.message };
  }
}

// ============================================================
// ADMIN-MANAGED BANK OPTIONS
// The list a cashier picks from when recording a bank transfer.
// ============================================================
export async function fetchBankOptions() {
  try {
    const { data, error } = await supabase.from('bank_options').select('*');
    if (error) throw error;
    if (!data) return;

    const pendingIds = new Set(
      (await db.bankOptions.where('synced').equals(0).toArray()).map((b) =>
        String(b.id)
      )
    );

    const mapped = data
      .filter((b) => !pendingIds.has(String(b.id)))
      .map((b) => ({
        id: String(b.id),
        name: b.name,
        active: b.active !== false,
        synced: 1
      }));

    if (mapped.length > 0) {
      await db.bankOptions.bulkPut(mapped);
    }
  } catch (err) {
    console.warn('Unable to fetch bank options:', err.message);
  }
}

export async function addBankOption(name, actor) {
  const bankOption = {
    id: generateId('BANK'),
    name: name.trim(),
    active: true,
    synced: 0
  };

  await db.bankOptions.add(bankOption);

  if (navigator.onLine) {
    try {
      const { error } = await supabase.from('bank_options').insert([
        { id: bankOption.id, name: bankOption.name, active: true }
      ]);
      if (!error) await db.bankOptions.update(bankOption.id, { synced: 1 });
    } catch (err) {
      console.warn('Cloud bank option create postponed:', err.message);
    }
  }

  await logAuditEvent({
    actorEmail: actor?.email,
    actorRole: actor?.role,
    action: 'bank_option_added',
    targetType: 'bank_option',
    targetId: bankOption.id,
    details: { name: bankOption.name }
  });

  return bankOption;
}

export async function removeBankOption(id, actor) {
  // Soft-disable rather than delete, so past tickets/sales that
  // recorded a transfer against this bank keep a readable name instead
  // of a dangling reference.
  await db.bankOptions.update(id, { active: false, synced: 0 });

  if (navigator.onLine) {
    try {
      const { error } = await supabase
        .from('bank_options')
        .update({ active: false })
        .eq('id', id);
      if (!error) await db.bankOptions.update(id, { synced: 1 });
    } catch (err) {
      console.warn('Cloud bank option removal postponed:', err.message);
    }
  }

  await logAuditEvent({
    actorEmail: actor?.email,
    actorRole: actor?.role,
    action: 'bank_option_removed',
    targetType: 'bank_option',
    targetId: id
  });
}

export async function syncPendingBankOptionsToCloud() {
  try {
    const pending = await db.bankOptions.where('synced').equals(0).toArray();
    if (pending.length === 0) return;

    for (const option of pending) {
      const { error } = await supabase.from('bank_options').upsert([
        { id: option.id, name: option.name, active: option.active }
      ]);
      if (!error) {
        await db.bankOptions.update(option.id, { synced: 1 });
      }
    }
  } catch (err) {
    console.warn('Unable to sync pending bank options:', err.message);
  }
}

// ============================================================
// AUDIT LOG: CROSS-DEVICE SYNC (administrator feature)
// Previously the Admin Audit Log only ever showed entries created on
// THIS device (useLiveQuery read straight from local Dexie, with
// nothing pulling other devices' entries down). This pulls every audit
// log entry from the last year down from Supabase, so any
// administrator can see what every manager AND every other
// administrator has done, regardless of which device they used.
// ============================================================
export async function fetchCloudAuditLog() {
  try {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    let allEntries = [];
    let from = 0;
    const PAGE_SIZE = 1000;

    while (true) {
      const { data: page, error } = await supabase
        .from('audit_log')
        .select('*')
        .gte('created_at', oneYearAgo.toISOString())
        .order('created_at', { ascending: false })
        .range(from, from + PAGE_SIZE - 1);

      if (error) throw error;
      if (!page || page.length === 0) break;

      allEntries = allEntries.concat(page);

      if (page.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    if (allEntries.length === 0) return;

    const pendingIds = new Set(
      (await db.auditLog.where('synced').equals(0).toArray()).map((e) =>
        String(e.id)
      )
    );

    const mapped = allEntries
      .filter((e) => !pendingIds.has(String(e.id)))
      .map((e) => ({
        id: String(e.id),
        actorEmail: e.actor_email,
        actorRole: e.actor_role,
        action: e.action,
        targetType: e.target_type || '',
        targetId: e.target_id || '',
        details: e.details ? JSON.stringify(e.details) : '',
        createdAt: e.created_at,
        synced: 1
      }));

    if (mapped.length > 0) {
      await db.auditLog.bulkPut(mapped);
    }
  } catch (err) {
    console.warn('Unable to fetch audit log from cloud:', err.message);
  }
}