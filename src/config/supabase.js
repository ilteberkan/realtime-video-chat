const { createClient } = require('@supabase/supabase-js');

let supabase;

const setupSupabase = () => {
  supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
  );
  
  console.log('Supabase bağlantısı kuruldu');
  return supabase;
};

const getSupabase = () => {
  if (!supabase) {
    return setupSupabase();
  }
  return supabase;
};

module.exports = { setupSupabase, getSupabase }; 