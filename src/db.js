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

ensureSeedData();

export async function syncDrugsFromCloud() {
  try {
    const { data: cloudDrugs, error } = await supabase.from('drugs').select('*');
    if (error) throw error;

    if (cloudDrugs && cloudDrugs.length > 0) {
      const mappedDrugs = cloudDrugs.map((drug) => ({
        id: String(drug.id),
        name: drug.name,
        unitType: drug.unit_type || drug.unitType || 'Sachet',
        costPrice: Number(drug.cost_price ?? drug.costPrice ?? 0),
        retailPrice: Number(drug.retail_price ?? drug.retailPrice ?? 0),
        wholesalePrice: Number(drug.wholesale_price ?? drug.wholesalePrice ?? 0),
        stock: Number(drug.stock ?? 0),
        barcode: drug.barcode || ''
      }));

      await db.drugs.bulkPut(mappedDrugs);
    }
  } catch (err) {
    console.warn('Unable to sync drugs from cloud:', err.message);
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