const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

async function audit() {
  console.log("🔍 Auditing Supabase Visits...");
  const { data, error } = await supabase
    .from('visits')
    .select('id, client_name, client_email, status, created_at')
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error("❌ Supabase Error:", error.message);
    return;
  }

  console.table(data);
  
  const total = data.length;
  const missingEmail = data.filter(v => !v.client_email).length;
  console.log(`\n📊 Summary: Total ${total} | Missing Email: ${missingEmail}`);
  
  if (missingEmail > 0) {
    console.warn("⚠️ Warning: Some visits are missing client_email. Confirmations won't work for these.");
  }
}

audit();
