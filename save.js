// server.js
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import XLSX from 'xlsx';

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const limiter = rateLimit({ windowMs: 15*60*1000, max: 1000 });
app.use(limiter);

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // required
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || null;
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(s=>s.trim()).filter(Boolean);

if(!SUPABASE_URL || !SUPABASE_SERVICE_KEY){
  console.error('Missing SUPABASE env vars'); process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

async function adminAuth(req, res, next){
  try{
    const key = req.headers['x-admin-key'] || req.query.admin_key || (req.headers['x-legacy-admin-key']);
    if(key && ADMIN_API_KEY && key === ADMIN_API_KEY) return next();

    const auth = (req.headers['authorization'] || '').split(' ');
    if(auth.length === 2 && auth[0].toLowerCase() === 'bearer'){
      const token = auth[1];
      const { data, error } = await sb.auth.getUser(token);
      if(error || !data?.user) return res.status(401).json({ error: 'invalid token' });
      const user = data.user;
      const role = user?.app_metadata?.role || '';
      if(role && role.toLowerCase() === 'admin'){ req.adminUser = user; return next(); }
      if(ADMIN_EMAILS.length && ADMIN_EMAILS.includes(user.email)) { req.adminUser = user; return next(); }
      return res.status(403).json({ error: 'forbidden' });
    }

    return res.status(401).json({ error: 'missing credentials' });
  }catch(e){
    console.error(e);
    return res.status(500).json({ error: 'auth error' });
  }
}

/* ---------- Helpers ---------- */
async function listCompanies(){
  const { data, error } = await sb.from('companies').select('code,name').order('code',{ascending:true});
  if(error) throw error;
  return data;
}

/* ---------- Endpoints ---------- */

// companies (for dropdown)
app.get('/api/admin/companies', adminAuth, async (req,res)=>{
  try{
    const rows = await listCompanies();
    res.json({ rows });
  }catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
});

// list portal (RPC or table)
app.get('/api/admin/list', adminAuth, async (req,res)=>{
  try{
    const code = String(req.query.code || '');
    // use RPC if exists
    try{
      const { data, error } = await sb.rpc('get_company_portal', { p_plain_code: code });
      if(!error) return res.json({ rows: data || [] });
    }catch(e){ /* fallback */ }
    // fallback: read from product_registrations
    const q = sb.from('product_registrations').select('*').eq('company_code', code);
    const { data, error } = await q;
    if(error) return res.status(500).json({ error: error.message });
    res.json({ rows: data || [] });
  }catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
});

// company-code: get plain_code via RPC or companies table
app.get('/api/admin/company-code', adminAuth, async (req,res)=>{
  const code = String(req.query.code || '');
  try{
    // try rpc
    try{
      const { data, error } = await sb.rpc('get_customer_code', { p_company_code: code });
      if(!error) return res.json({ plain_code: data?.plain_code || null });
    }catch(e){}
    const { data, error } = await sb.from('companies').select('plain_code').eq('code', code).single();
    if(error) return res.json({ plain_code: null });
    res.json({ plain_code: data?.plain_code || null });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

// set-customer-code RPC wrapper
app.post('/api/admin/set-customer-code', adminAuth, async (req,res)=>{
  try{
    const { company_code, plain_code } = req.body;
    const { error } = await sb.rpc('set_customer_code', { p_company_code: company_code, p_plain_code: plain_code });
    if(error) return res.status(500).json({ error: error.message });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

// upsert product (product includes id for update)
app.post('/api/admin/product', adminAuth, async (req,res)=>{
  try{
    const { company_code, company_name, product } = req.body;
    if(!product) return res.status(400).json({ error: 'missing product' });

    // find or create company
    const codeUp = (company_code||'').trim();
    let company_id = null;
    if(codeUp){
      const { data: company } = await sb.from('companies').select('id').eq('code', codeUp).limit(1);
      if(company && company.length) company_id = company[0].id;
      else{
        const ins = await sb.from('companies').insert({ code: codeUp, name: company_name || codeUp }).select('id').single();
        if(ins.error) throw ins.error; company_id = ins.data.id;
      }
    }

    // if product.id present -> update
    if(product.id){
      const id = product.id;
      const p = { ...product }; delete p.id;
      const { error } = await sb.from('product_registrations').update(p).eq('id', id);
      if(error) return res.status(500).json({ error: error.message });
      return res.json({ ok:true });
    }

    // insert new
    const insert = { company_code: codeUp, company_id, ...product };
    const { data, error } = await sb.from('product_registrations').insert(insert).select('id').single();
    if(error) return res.status(500).json({ error: error.message });
    res.json({ ok:true, id: data.id });
  }catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
});

// delete product
app.delete('/api/admin/product/:id', adminAuth, async (req,res)=>{
  try{
    const id = req.params.id;
    const { error } = await sb.from('product_registrations').delete().eq('id', id);
    if(error) return res.status(500).json({ error: error.message });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

// bulk delete
app.post('/api/admin/bulk-delete', adminAuth, async (req,res)=>{
  try{
    const { ids } = req.body;
    if(!Array.isArray(ids)) return res.status(400).json({ error: 'ids must be array' });
    const { error } = await sb.from('product_registrations').delete().in('id', ids);
    if(error) return res.status(500).json({ error: error.message });
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ error: e.message }); }
});

// import CSV/XLSX (multipart)
app.post('/api/admin/import-csv', adminAuth, upload.single('file'), async (req,res)=>{
  try{
    if(!req.file) return res.status(400).json({ error: 'missing file' });
    const replaceMode = req.body.replace_mode === '1' || req.body.replace_mode === 'true';
    const company_code = req.body.company_code;
    // Parse file buffer with SheetJS if xlsx, else csv-parse
    const filename = (req.file.originalname || '').toLowerCase();
    let records = [];
    if(filename.endsWith('.csv')){
      const text = req.file.buffer.toString('utf8');
      records = parse(text, { columns: true, skip_empty_lines: true });
    }else{
      const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates:true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      records = XLSX.utils.sheet_to_json(ws, { defval: '' });
    }

    // map fields and normalize dates
    const normalizeDate = (v)=>{
      if(!v) return null;
      if(v instanceof Date && !isNaN(v)) return v.toISOString().slice(0,10);
      if(typeof v === 'number'){ const epoch = new Date(Math.round((v - 25569) * 86400 * 1000)); return epoch.toISOString().slice(0,10); }
      const s = String(v).trim();
      const iso = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
      if(iso) return `${iso[1]}-${iso[2].padStart(2,'0')}-${iso[3].padStart(2,'0')}`;
      const dmy = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
      if(dmy){ let y=Number(dmy[3]); if(y<100) y+= (y>=70?1900:2000); return `${y}-${String(dmy[2]).padStart(2,'0')}-${String(dmy[1]).padStart(2,'0')}`; }
      return null;
    };

    // map rows -> product_registrations fields
    const mapped = records.map(r=>{
      const brand = r.brand_name || r['ชื่อการค้า'] || '';
      const common = r.common_label || r['ชื่อสามัญ/สูตร'] || '';
      const regno = r.registration_no || r['ทะเบียน'] || null;
      const importer = r.importer || r['ผู้นำเข้า'] || null;
      const manufacturer_source = r.manufacturer_source || r['ผู้ผลิต/แหล่งผลิต'] || null;
      const distributor = r.distributor || r['ผู้จำหน่าย'] || null;
      const packed_volume = r.packed_volume || r['นำเข้า/แบ่งบรรจุ'] || null;
      const registration_date = normalizeDate(r.registration_date || r['วันออกทะเบียน']);
      const expiry_date = normalizeDate(r.expiry_date || r['วันหมดอายุ']);
      const license_no = r.license_no || r['ใบอนุญาต'] || null;
      return { company_code, brand_name: String(brand).trim(), common_label: String(common).trim(), registration_no: regno, importer, manufacturer_source, distributor, packed_volume, registration_date, expiry_date, license_no };
    }).filter(x=>x.brand_name && x.common_label);

    if(replaceMode){
      await sb.from('product_registrations').delete().eq('company_code', company_code);
    }

    const CHUNK = 500;
    const results = { total: mapped.length, success:0, failed:0, errors:[] };
    for(let i=0;i<mapped.length;i+=CHUNK){
      const chunk = mapped.slice(i,i+CHUNK);
      const { error } = await sb.from('product_registrations').insert(chunk);
      if(error){
        results.failed += chunk.length;
        results.errors.push(error.message);
      }else results.success += chunk.length;
    }
    res.json({ ok:true, results });
  }catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
});

// export -> returns xlsx blob
app.get('/api/admin/export', adminAuth, async (req,res)=>{
  try{
    const code = String(req.query.code || '');
    if(!code) return res.status(400).json({ error: 'missing code' });
    const { data, error } = await sb.from('product_registrations').select('*').eq('company_code', code);
    if(error) return res.status(500).json({ error: error.message });
    const aoa = [['company_code','brand_name','common_label','registration_no','importer','manufacturer_source','distributor','packed_volume','registration_date','expiry_date','license_no']];
    (data||[]).forEach(r=> aoa.push([r.company_code||'', r.brand_name||'', r.common_label||'', r.registration_no||'', r.importer||'', r.manufacturer_source||'', r.distributor||'', r.packed_volume||'', r.registration_date||'', r.expiry_date||'', r.license_no||'']));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'registrations');
    const buf = XLSX.write(wb, { type:'buffer', bookType:'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename=registrations_${code}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  }catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
});

const PORT = Number(process.env.PORT||3000);
app.listen(PORT, ()=> console.log(`Admin proxy listening on ${PORT}`));
