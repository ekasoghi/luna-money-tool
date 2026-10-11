# Luna Money Tool

Aplikasi arus kas pribadi dan usaha: scan/upload nota, kategori otomatis, anggaran, laporan arus kas harian, mingguan, bulanan, tahunan, dengan login dan data terenkripsi.

Situs statis (tanpa build). Setiap perubahan yang di-push ke branch `main` otomatis terbit di Netlify.

- Pengaturan pemilik: `config.js`
- Panduan lengkap: `PANDUAN-HOSTING.md`
- Database & langganan: `supabase.sql`
- Pembayaran Xendit (Supabase Edge Functions): `supabase/functions/xendit-invoice`, `supabase/functions/xendit-webhook`
- Saat merilis versi baru, naikkan `VERSION` di `sw.js`.
