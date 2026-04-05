const { createClient } = require('@supabase/supabase-js');

/**
 * Supabase Service
 * Handles lead storage and real-time notifications
 */
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

// Initialize only if credentials exist
const supabase = (supabaseUrl && supabaseKey) ? createClient(supabaseUrl, supabaseKey) : null;

const saveLeadToSupabase = async (lead) => {
  if (!supabase) {
    console.warn('⚠️ Supabase not configured. Falling back to MongoDB...');
    return { success: false, error: 'SUPABASE_URL or SUPABASE_ANON_KEY missing' };
  }

  try {
    // Ensure lead has essential fields for Supabase
    const leadRecord = {
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      property_interest: lead.property_interest,
      notes: lead.notes,
      source: lead.source || 'Website',
      status: lead.status || 'New',
      created_at: new Date().toISOString()
    };

    const { data, error } = await supabase
      .from('leads')
      .insert([leadRecord]);

    if (error) throw error;
    return { success: true, data };
  } catch (error) {
    console.error('❌ Supabase Save Error:', error.message);
    return { success: false, error: error.message };
  }
};

const pushNotification = async (agentEmail, type, message) => {
  // Existing mock/prepared logic for notifications
  console.log(`🔔 Notification for ${agentEmail}: [${type}] ${message}`);
  return { success: true };
};

module.exports = { pushNotification, saveLeadToSupabase };
