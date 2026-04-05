-- Run this SQL in your Supabase SQL Editor to create the leads table
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

-- Enable Realtime (optional, for the dashboard)
ALTER PUBLICATION supabase_realtime ADD TABLE leads;
