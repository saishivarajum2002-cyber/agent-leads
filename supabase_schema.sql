-- ============================================================
-- PropEdge Production Schema — Supabase SQL Editor
-- Run this entire file in your Supabase SQL Editor
-- ============================================================

-- 1. LEADS TABLE (original + new AI qualification columns)
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  property_interest TEXT,
  notes TEXT,
  source TEXT DEFAULT 'Website',
  status TEXT DEFAULT 'New',
  -- NEW: AI Pre-Qualification Fields
  budget TEXT,
  bhk_preference TEXT,
  pre_approval_status TEXT,
  qualification_score INTEGER DEFAULT 0,
  qualification_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. VISITS TABLE (original + agreement/qualification linkage)
CREATE TABLE IF NOT EXISTS visits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  property_name TEXT,
  client_name TEXT NOT NULL,
  client_email TEXT,
  client_phone TEXT,
  visit_date DATE NOT NULL,
  visit_time TIME NOT NULL,
  status TEXT DEFAULT 'pending',
  outcome TEXT,
  notes TEXT,
  -- NEW: Compliance & Tracking Fields
  agreement_id TEXT,
  qualification_id TEXT,
  whatsapp_sent BOOLEAN DEFAULT FALSE,
  virtual_tour_link TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. AI QUALIFICATIONS TABLE (stores chatbot Q&A results)
CREATE TABLE IF NOT EXISTS ai_qualifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_token TEXT UNIQUE NOT NULL,
  name TEXT,
  email TEXT,
  phone TEXT,
  budget TEXT NOT NULL,
  bhk_preference TEXT NOT NULL,
  pre_approval_status TEXT NOT NULL,
  qualification_score INTEGER DEFAULT 0,
  is_qualified BOOLEAN DEFAULT FALSE,
  answers JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 4. BUYER AGREEMENTS TABLE (stores signed digital agreements)
CREATE TABLE IF NOT EXISTS buyer_agreements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_token TEXT UNIQUE NOT NULL,
  signer_name TEXT NOT NULL,
  signer_email TEXT,
  signer_phone TEXT,
  ip_address TEXT,
  signed_at TIMESTAMP WITH TIME ZONE NOT NULL,
  agreement_version TEXT DEFAULT 'v1.0',
  agreement_text TEXT,
  property_name TEXT,
  qualification_id TEXT,
  visit_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 5. DOCUMENTS TABLE (stores document metadata linked to leads/visits)
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id TEXT,
  visit_id TEXT,
  agreement_id TEXT,
  doc_type TEXT NOT NULL,        -- 'id_proof' | 'agreement' | 'booking_form' | 'other'
  file_name TEXT NOT NULL,
  file_data TEXT,                -- base64 encoded file content
  file_mime TEXT DEFAULT 'application/pdf',
  file_size_kb INTEGER,
  uploader TEXT DEFAULT 'agent', -- 'agent' | 'buyer'
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- ============================================================
-- INDEXES for performance
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_qualifications_session ON ai_qualifications(session_token);
CREATE INDEX IF NOT EXISTS idx_agreements_session ON buyer_agreements(session_token);
CREATE INDEX IF NOT EXISTS idx_agreements_email ON buyer_agreements(signer_email);
CREATE INDEX IF NOT EXISTS idx_documents_lead ON documents(lead_id);
CREATE INDEX IF NOT EXISTS idx_documents_visit ON documents(visit_id);
CREATE INDEX IF NOT EXISTS idx_visits_agreement ON visits(agreement_id);
CREATE INDEX IF NOT EXISTS idx_leads_qualification ON leads(qualification_id);

-- ============================================================
-- REALTIME (enable for dashboard live updates)
-- ============================================================
ALTER PUBLICATION supabase_realtime ADD TABLE visits;
ALTER PUBLICATION supabase_realtime ADD TABLE leads;
ALTER PUBLICATION supabase_realtime ADD TABLE ai_qualifications;
ALTER PUBLICATION supabase_realtime ADD TABLE buyer_agreements;
ALTER PUBLICATION supabase_realtime ADD TABLE documents;
