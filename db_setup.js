const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

/**
 * PropEdge Database Initializer
 * Usage: node db_setup.js <YOUR_SERVICE_ROLE_KEY>
 */

const serviceRoleKey = process.argv[2] || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseUrl = process.env.SUPABASE_URL;

if (!supabaseUrl || !serviceRoleKey) {
  console.error('❌ Error: Missing credentials.');
  console.log('Usage: node db_setup.js <YOUR_SERVICE_ROLE_KEY>');
  console.log('Or add SUPABASE_SERVICE_ROLE_KEY to your .env file.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceRoleKey);

async function setup() {
  console.log('🚀 Starting Database Setup...');
  
  const sqlPath = path.join(__dirname, 'supabase_schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  
  // Note: Supabase JS client doesn't support running arbitrary SQL files directly 
  // without the 'rpc' extension or a custom worker. 
  // The most reliable way for the user is still the SQL Editor.
  
  console.log('\n⚠️ IMPORTANT: The Supabase JS client cannot execute full SQL schema files directly.');
  console.log('I have prepared the code, but you MUST follow these steps to "DO" the fix:\n');
  console.log('1. Open: https://supabase.com/dashboard/project/' + supabaseUrl.split('//')[1].split('.')[0] + '/sql');
  console.log('2. Click "New Query"');
  console.log('3. Open the file: ' + sqlPath);
  console.log('4. Copy ALL text and paste it into the editor.');
  console.log('5. Click "RUN".\n');
  
  console.log('Checking current table status...');
  const { error: qualError } = await supabase.from('ai_qualifications').select('id').limit(1);
  
  if (qualError && qualError.code === '42P01') {
    console.log('❌ Table "ai_qualifications" is MISSING.');
  } else if (qualError) {
    console.log('❓ Table check returned error:', qualError.message);
  } else {
    console.log('✅ Table "ai_qualifications" exists!');
  }
}

setup();
