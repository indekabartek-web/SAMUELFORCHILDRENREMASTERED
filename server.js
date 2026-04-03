require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mysql = require('mysql2/promise');
const multer = require('multer');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();
app.use(cors()); 
app.use(express.json());

// ==============================================================================
// MYSQL
// ==============================================================================
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function initDB() {
    try {
        const connection = await pool.getConnection();
        
        await connection.query(`
    CREATE TABLE IF NOT EXISTS products (
        id VARCHAR(50) PRIMARY KEY,
        title_pl VARCHAR(255),
        title_en VARCHAR(255),
        desc_pl TEXT,
        desc_en TEXT,
        price DECIMAL(10, 2),
        stripe_price_id VARCHAR(100), 
        category VARCHAR(50),
        img VARCHAR(255),
        img_back VARCHAR(255),
        img_desc VARCHAR(255),
        is_bilingual BOOLEAN,
        out_of_stock BOOLEAN DEFAULT 0
    )
`);
        // Aktualizacja istniejącej tabeli (ignoruje błąd, jeśli kolumny już istnieją)
        try { await connection.query(`ALTER TABLE products ADD COLUMN stripe_price_id VARCHAR(100)`); } catch(e) {}
        try { await connection.query(`ALTER TABLE products ADD COLUMN out_of_stock BOOLEAN DEFAULT 0`); } catch(e) {}

        console.log("✅ Baza gotowa. Kolumna out_of_stock podpięta!");
        connection.release();
    } catch (error) {
        console.error("❌ Błąd bazy danych:", error.message);
    }
}
initDB();

// ==============================================================================
// UPLOAD PLIKÓW I ZAPIS
// ==============================================================================
const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, 'img/'); },
    filename: (req, file, cb) => {
        const bookId = req.body.id || 'nieznany';
        let suffix = '';
        if (file.fieldname === 'img_back') suffix = '-2strona';
        if (file.fieldname === 'img_desc') suffix = '-opis';
        cb(null, `${bookId}${suffix}-${Date.now()}.webp`); // Zabezpieczenie przed cache przeglądarki
    }
});

const upload = multer({ storage: storage });

app.post('/api/products', upload.fields([
    { name: 'img', maxCount: 1 }, { name: 'img_back', maxCount: 1 }, { name: 'img_desc', maxCount: 1 }
]), async (req, res) => {
    try {
        const { id, title_pl, title_en, desc_pl, desc_en, price, stripe_price_id, category, is_bilingual, out_of_stock, existing_img, existing_img_back, existing_img_desc } = req.body;
        
        // Jeśli plik wgrany - użyj nowego. Jeśli nie - użyj starej ścieżki (existing_img) przysłanej z frontu
        const imgPath = req.files['img'] ? 'img/' + req.files['img'][0].filename : (existing_img || '');
        const imgBackPath = req.files['img_back'] ? 'img/' + req.files['img_back'][0].filename : (existing_img_back || '');
        const imgDescPath = req.files['img_desc'] ? 'img/' + req.files['img_desc'][0].filename : (existing_img_desc || '');

        const isBilingualBool = is_bilingual === 'true' || is_bilingual === true ? 1 : 0;
        const outOfStockBool = out_of_stock === 'true' || out_of_stock === true ? 1 : 0;

        await pool.query(
            `INSERT INTO products (id, title_pl, title_en, desc_pl, desc_en, price, stripe_price_id, category, img, img_back, img_desc, is_bilingual, out_of_stock) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE 
             title_pl=?, title_en=?, desc_pl=?, desc_en=?, price=?, stripe_price_id=?, category=?, img=?, img_back=?, img_desc=?, is_bilingual=?, out_of_stock=?`,
            [id, title_pl, title_en, desc_pl, desc_en, price, stripe_price_id, category, imgPath, imgBackPath, imgDescPath, isBilingualBool, outOfStockBool,
             title_pl, title_en, desc_pl, desc_en, price, stripe_price_id, category, imgPath, imgBackPath, imgDescPath, isBilingualBool, outOfStockBool]
        );

        res.json({ success: true });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: "Błąd serwera." });
    }
});

app.get('/api/products', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM products');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: "Błąd pobierania." });
    }
});

// PŁATNOŚCI STRIPE Z BAZY DANYCH
const YOUR_DOMAIN = 'https://samuelforchildren.com'; 

app.post('/create-checkout-session', async (req, res) => {
    try {
        const { cart, phone, paczkomat } = req.body;
        if (!cart || cart.length === 0 || !phone || !paczkomat) {
            return res.status(400).json({ error: 'Brak danych.' });
        }

        const [dbProducts] = await pool.query('SELECT id, stripe_price_id, out_of_stock FROM products');

        const lineItems = cart.map((cartItem) => {
            const dbProduct = dbProducts.find(p => p.id === cartItem.id);
            if (!dbProduct || !dbProduct.stripe_price_id) throw new Error(`Produkt ${cartItem.id} nie ma ID Stripe w bazie.`);
            if (dbProduct.out_of_stock) throw new Error(`Produkt ${cartItem.id} jest wyprzedany.`);

            return { price: dbProduct.stripe_price_id, quantity: cartItem.quantity };
        });

        lineItems.push({
            price_data: {
                currency: 'pln',
                product_data: { name: 'Wysyłka: InPost Paczkomaty 24/7', description: `Paczkomat: ${paczkomat}` },
                unit_amount: 1500,
            },
            quantity: 1,
        });

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card', 'blik', 'p24'], 
            line_items: lineItems, mode: 'payment',
            success_url: `${YOUR_DOMAIN}/?status=success`, cancel_url: `${YOUR_DOMAIN}/?status=cancel`,
            metadata: { 'Telefon': phone, 'Paczkomat': paczkomat }
        });
        
        res.json({ url: session.url });
    } catch (error) {
        console.error('Stripe Error:', error);
        res.status(500).json({ error: error.message || 'Błąd płatności.' });
    }
});

// STATYKA I START
app.use(express.static(__dirname));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => { console.log(`🚀 Serwer działa na porcie ${PORT}`); });