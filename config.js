/* =========================================================
   Pengaturan Luna Money Tool — diisi SEKALI oleh pemilik aplikasi.

   Biarkan supabaseUrl dan supabaseKey kosong jika hanya ingin
   "akun perangkat" (data terenkripsi, tersimpan di HP/laptop masing-masing).

   Isi keduanya untuk mengaktifkan "akun cloud": daftar & masuk dengan
   email, data tersinkron antara HP dan laptop. Lihat PANDUAN-HOSTING.md.

   PENTING: hanya isi "anon" / "publishable" key. JANGAN PERNAH menaruh
   service_role / secret key di file ini — file ini bisa dibaca siapa saja.
   ========================================================= */
window.LUNA_CONFIG = {
  supabaseUrl: "",          // contoh: "https://abcd1234.supabase.co"
  supabaseKey: "",          // contoh: "sb_publishable_xxx" atau "eyJhbGciOi..."
  allowLocalAccounts: false, // false = setiap pendaftar wajib akun cloud + link aktivasi email (berlaku jika Supabase diisi)
  allowCloudSignup: true    // false = pendaftaran baru ditutup (hanya akun yang sudah ada bisa masuk)
};
