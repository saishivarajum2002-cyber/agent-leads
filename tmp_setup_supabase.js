const { Client } = require('pg');

const client = new Client({
  host: 'lpyzckwhxbclsptzzuig.supabase.co',
  port: 6543,
  user: 'postgres',
  password: 'CNcDmWm9teLq0KzN',
  database: 'postgres',
  ssl: {
    rejectUnauthorized: false
  }
});

const sql = `
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Create leads table
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  property_interest TEXT,
  notes TEXT,
  source TEXT DEFAULT 'Website',
  status TEXT DEFAULT 'New',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable Realtime
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE leads;
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Could not add to publication';
END $$;
`;

async function run() {
  try {
    console.log('Connecting to Supabase PostgreSQL...');
    await client.connect();
    console.log('Connected. Executing SQL...');
    await client.query(sql);
    console.log('✅ SQL setup completed successfully!');
    
    // Verify table exists
    const res = await client.query("SELECT count(*) FROM leads;");
    console.log(`Verified: 'leads' table has ${res.rows[0].count} entries.`);
    
  } catch (err) {
    console.error('❌ Error executing SQL:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
