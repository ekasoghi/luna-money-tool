# Luna Money Tool — Panduan Upload, Login & Keamanan (versi 2)

## Jawaban singkat: perlu VPS?

**Tidak perlu.** Luna Money Tool adalah aplikasi web statis (HTML + JavaScript). Login, enkripsi, scan nota, dan laporan semuanya berjalan di browser HP atau laptop pengguna. Hosting cukup menyimpan dan mengirim file.

| Pilihan | Cocok untuk | Biaya | Kesulitan |
|---|---|---|---|
| **A. Netlify / Cloudflare Pages** (disarankan) | Cepat online, HTTPS otomatis, header keamanan otomatis dari file `_headers` | Paket gratis | Sangat mudah (drag & drop) |
| **B. Shared hosting cPanel** | Sudah punya hosting + domain | Sesuai paket | Mudah (file `.htaccess` sudah disiapkan) |
| C. VPS | Hanya jika nanti membangun server/API sendiri | Bulanan | Perlu keahlian server |

**Wajib HTTPS** (alamat `https://`). Tanpa HTTPS, Luna menolak dibuka karena enkripsi data, login, dan kamera hanya diizinkan browser di koneksi aman.

---

## Isi folder

```
luna-money-tool/
├── index.html            ← aplikasi utama
├── config.js             ← pengaturan pemilik (akun cloud on/off) — EDIT INI
├── manifest.webmanifest  ← agar bisa di-install seperti aplikasi
├── sw.js                 ← agar tetap terbuka saat offline
├── _headers              ← header keamanan (Netlify / Cloudflare Pages)
├── .htaccess             ← paksa HTTPS + header keamanan (cPanel / Apache)
├── icons/                ← ikon bulan sabit
├── supabase.sql          ← tabel untuk akun cloud (opsional)
└── PANDUAN-HOSTING.md    ← panduan ini
```

Catatan: `.htaccess` adalah file tersembunyi (diawali titik). Di File Manager cPanel aktifkan **Settings → Show Hidden Files** untuk melihatnya.

---

## Langkah 1 — Pilih model akun

Luna punya dua jenis akun. Anda (pemilik) menentukan lewat `config.js`.

### Akun perangkat (bawaan, tanpa setup tambahan)
- Daftar dengan nama, email, kata sandi. Tidak ada data yang dikirim ke internet.
- Semua transaksi dan foto nota **dienkripsi AES-256-GCM** dengan kunci yang hanya terbuka oleh kata sandi pengguna. Orang lain yang memegang HP/laptop tidak bisa membaca datanya tanpa kata sandi atau PIN.
- Saat daftar, pengguna mendapat **kode pemulihan** (XXXX-XXXX-XXXX-XXXX). Hanya kode ini yang bisa membuka data jika kata sandi lupa. Pastikan pengguna menyimpannya.
- Data tidak sinkron antar perangkat (pakai Cadangan .json untuk memindahkan).

### Akun cloud (disarankan agar HP dan laptop memakai data yang sama)
- Daftar dengan email + kata sandi, wajib verifikasi email.
- Data tersimpan di database Supabase Anda, dilindungi **Row Level Security**: setiap akun hanya bisa membaca datanya sendiri.
- Salinan di perangkat tetap dienkripsi seperti akun perangkat.
- Lupa kata sandi: tautan atur ulang dikirim ke email.

Biarkan `config.js` apa adanya untuk akun perangkat saja. Untuk akun cloud, ikuti Langkah 2.

---

## Langkah 2 (opsional) — Aktifkan akun cloud dengan Supabase

1. Daftar di **supabase.com** → **New project**. Pilih region **Southeast Asia (Singapore)**. Simpan kata sandi database.
2. **SQL Editor → New query** → tempel isi `supabase.sql` → **Run**.
3. **Authentication → URL Configuration**:
   - **Site URL**: alamat Luna Anda, misalnya `https://luna-money-anda.netlify.app`
   - **Redirect URLs**: tambahkan alamat yang sama.
   Ini membuat tautan verifikasi email dan atur ulang kata sandi kembali ke aplikasi Anda.
4. **Authentication → Sign In / Providers → Email**: pastikan **Confirm email** aktif.
5. **Project Settings → API** (atau tombol **Connect**): salin **Project URL** dan **anon / publishable key**.
6. Buka `config.js`, isi:
   ```js
   supabaseUrl: "https://abcd1234.supabase.co",
   supabaseKey: "sb_publishable_xxxxx",
   ```
   **Jangan pernah** memakai `service_role` / `secret` key.
7. Pengaturan tambahan di `config.js`:
   - `allowLocalAccounts: false` → semua pengguna wajib akun cloud.
   - `allowCloudSignup: false` → tutup pendaftaran baru setelah akun Anda (dan keluarga/tim) dibuat. Agar benar-benar tertutup, matikan juga **Allow new users to sign up** di Supabase (Authentication → Sign In / Providers).

Catatan email: layanan email bawaan Supabase dibatasi jumlahnya per jam dan ditujukan untuk uji coba. Untuk banyak pengguna, atur SMTP sendiri di **Authentication → Emails → SMTP Settings**.

---

## Langkah 3 — Upload

### Netlify (±5 menit)
1. **app.netlify.com** → daftar → **Add new site → Deploy manually**.
2. Seret folder `luna-money-tool` ke kotak upload.
3. **Site configuration → Change site name** → misalnya `luna-money-anda`.
4. Jika memakai akun cloud: salin alamat final ke Supabase (Langkah 2 poin 3).

### Cloudflare Pages
1. **dash.cloudflare.com → Workers & Pages → Create → Pages → Upload assets**.
2. Beri nama proyek, upload folder, **Deploy**.

### cPanel
1. **File Manager → public_html** (atau folder subdomain seperti `money.domainanda.com`).
2. Upload `luna-money-tool.zip` → klik kanan → **Extract**. Pastikan `index.html` dan `.htaccess` berada langsung di folder tujuan.
3. **SSL/TLS Status → Run AutoSSL** (atau "Let's Encrypt SSL").
4. Buka `https://alamat-anda`.

---

## Langkah 4 — Pemakaian pertama

1. Buka alamat Luna → tab **Daftar** → isi nama, email, kata sandi (minimal 8 karakter, huruf + angka).
2. Akun perangkat: simpan **kode pemulihan**, centang konfirmasi, lalu lanjut.
   Akun cloud: buka email verifikasi, kembali ke Luna, lalu **Masuk**.
3. Jika sebelumnya sudah mencatat transaksi di versi lama, centang **Pindahkan data yang sudah tercatat** saat daftar. Data lama dipindahkan dan dienkripsi.
4. Buka **Akun & Pengaturan**:
   - isi **Saldo awal Pribadi** dan **Saldo awal Usaha** (total kas + rekening + e-wallet saat mulai),
   - atur **PIN 6 digit** untuk membuka cepat di HP,
   - pilih **Kunci otomatis** (1–30 menit tidak dipakai).
5. Pasang di HP: Chrome Android → **Instal aplikasi**; Safari iPhone → **Bagikan → Tambah ke Layar Utama**.

---

## Fitur keamanan

| Fitur | Penjelasan |
|---|---|
| Registrasi & login | Email + kata sandi, validasi kekuatan sandi |
| Enkripsi data | Transaksi dan foto nota di perangkat dienkripsi AES-256-GCM; kunci diturunkan dari kata sandi dengan PBKDF2-SHA256 600.000 iterasi |
| PIN cepat | 6 digit; nonaktif otomatis setelah 5 kali salah |
| Batas percobaan | 5 kali salah kata sandi → jeda bertahap (30 detik hingga 15 menit) |
| Kunci otomatis | Setelah tidak dipakai, atau saat aplikasi ditinggal di latar belakang |
| Kode pemulihan | Untuk akun perangkat jika lupa kata sandi |
| Atur ulang via email | Untuk akun cloud |
| Isolasi data cloud | Row Level Security: setiap akun hanya melihat datanya sendiri |
| Keluar & hapus data perangkat | Pilihan saat keluar dari perangkat bersama |
| Header keamanan | Anti-clickjacking, HTTPS wajib, izin kamera hanya untuk situs sendiri |

Hal yang tetap perlu dijaga pengguna: jangan bagikan kata sandi/PIN, simpan kode pemulihan, dan simpan file **Cadangan .json** di tempat pribadi (file cadangan tidak terenkripsi agar bisa dibuka di Excel/aplikasi lain).

---

## Scan dan upload nota

Tombol **Nota** (HP) atau **Scan / Upload Nota** (laptop) menawarkan:
- **Foto nota**: kamera langsung terbuka.
- **Upload dari galeri**: foto struk, screenshot bukti transfer m-banking, bukti bayar QRIS, atau e-wallet (GoPay, OVO, DANA, ShopeePay). Bisa memilih beberapa gambar sekaligus; Luna memproses satu per satu dan Anda cukup cek lalu **Simpan** atau **Lewati**.
- Di laptop: seret gambar ke jendela Luna, atau tempel screenshot dengan **Ctrl+V**.

Luna mengenali nominal, tanggal, toko atau penerima/pengirim, metode bayar, dan apakah itu uang keluar atau **dana masuk**. Saldo rekening, nomor referensi, dan nomor rekening diabaikan agar tidak terbaca sebagai nominal. Screenshot mode gelap otomatis dibalik warnanya agar terbaca. Gambar diproses di perangkat dan disimpan terenkripsi sebagai bukti.

---

## Laporan arus kas

Menu **Laporan** punya empat mode: **Harian, Mingguan, Bulanan, Tahunan**. Setiap laporan berisi:
- Saldo awal, kas masuk, kas keluar, saldo akhir.
- Grafik masuk/keluar dengan garis saldo.
- Laporan arus kas (masuk per sumber, keluar per kategori).
- Rincian: harian → per transaksi dengan saldo berjalan; mingguan → per hari; bulanan → per minggu; tahunan → per bulan.
- Buku Usaha: arus kas per aktivitas (operasi, investasi, pendanaan) dan Laba Rugi.
- Ekspor **CSV laporan**, **CSV transaksi**, dan **Cetak / PDF**.

---

## Merilis versi baru

1. Ganti file yang berubah.
2. Di `sw.js`, naikkan versi, contoh `luna-v2.0.0` → `luna-v2.0.1`.
3. Upload ulang. Pengguna mendapat versi baru setelah menutup dan membuka aplikasi.

## Masalah umum

| Gejala | Solusi |
|---|---|
| Muncul "Tidak bisa dibuka dengan aman" | Situs belum HTTPS. Aktifkan SSL lalu buka `https://…`. |
| Kamera tidak terbuka | Izinkan kamera di pengaturan browser untuk situs Luna. Atau pakai **Upload dari galeri**. |
| Tidak menerima email verifikasi | Cek folder Spam; pastikan Site URL di Supabase benar; untuk banyak pengguna pasang SMTP sendiri. |
| Lupa kata sandi akun perangkat | Pakai kode pemulihan di **Lupa kata sandi?**. Tanpa kode, data memang tidak bisa dibuka (itulah tujuan enkripsi). |
| Data HP dan laptop berbeda | Pastikan memakai **akun cloud** yang sama di keduanya. Akun perangkat tidak sinkron. |
| "Cloud: masuk ulang untuk sinkron" | Buka **Akun & Pengaturan → Masuk ulang ke cloud**. |
| Nominal nota salah terbaca | Foto lebih terang dan tegak, atau koreksi sebelum menyimpan. |
