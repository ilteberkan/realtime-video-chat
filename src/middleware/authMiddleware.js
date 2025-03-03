const { createClient } = require('@supabase/supabase-js');

// Supabase istemcisini oluştur
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Admin kimlik doğrulama middleware
const authenticateAdmin = async (req, res, next) => {
  try {
    console.log('Admin kimlik doğrulama middleware çalışıyor...');
    
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('Yetkilendirme başlığı eksik veya geçersiz');
      return res.status(401).json({ error: 'Yetkilendirme başlığı gerekli' });
    }
    
    const token = authHeader.split(' ')[1];
    
    // Token ile kullanıcı bilgilerini al
    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    
    if (userError || !userData || !userData.user) {
      console.log('Geçersiz token veya kullanıcı bulunamadı:', userError);
      return res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token' });
    }
    
    console.log('Kullanıcı bulundu:', userData.user.email);
    
    // Veritabanından admin kontrolü
    const { data: adminData, error: adminError } = await supabase
      .from('admins')
      .select('*')
      .eq('user_id', userData.user.id)
      .single();
    
    if (adminError || !adminData) {
      console.log('Kullanıcı admin değil veya admin tablosunda bulunamadı');
      return res.status(403).json({ error: 'Bu işlem için admin yetkisi gerekli' });
    }
    
    // Kullanıcı bilgilerini request nesnesine ekle
    req.user = userData.user;
    
    console.log('Admin kimlik doğrulama başarılı');
    next();
  } catch (err) {
    console.error('Admin kimlik doğrulama hatası:', err);
    res.status(500).json({ error: 'Kimlik doğrulama sırasında bir hata oluştu' });
  }
};

// Kimlik doğrulama middleware
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Yetkilendirme başlığı gerekli' });
    }
    
    const token = authHeader.split(' ')[1];
    
    const { data, error } = await supabase.auth.getUser(token);
    
    if (error || !data.user) {
      return res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token' });
    }
    
    // Kullanıcının banlı olup olmadığını kontrol et
    const { data: banData, error: banError } = await supabase
      .from('user_bans')
      .select('*')
      .eq('user_id', data.user.id)
      .gte('ban_expires_at', new Date().toISOString())
      .single();
    
    if (!banError && banData) {
      return res.status(403).json({ 
        error: 'Hesabınız banlandı', 
        banInfo: {
          reason: banData.reason,
          expiresAt: banData.ban_expires_at
        }
      });
    }
    
    req.user = data.user;
    next();
  } catch (err) {
    console.error('Kimlik doğrulama hatası:', err);
    res.status(500).json({ error: 'Kimlik doğrulama sırasında bir hata oluştu' });
  }
};

module.exports = { authenticate, authenticateAdmin }; 