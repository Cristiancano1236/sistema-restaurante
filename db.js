const mysql = require('mysql2');

const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: '111',
    database: 'reconocimiento',
    connectionLimit: 10,
    waitForConnections: true,
    queueLimit: 0
}).promise();

/**
 * Asegura el esquema mínimo requerido para nuevas funcionalidades (sin romper instalaciones existentes).
 * - Crea tabla factura_pagos (1 factura -> N pagos)
 * - Amplía ENUM facturas.forma_pago para soportar tarjeta/mixto
 * - Columnas de stock en productos y tabla stock_movimientos
 *
 * Relacionado con:
 * - routes/facturas.js (facturación desde index)
 * - routes/mesas.js (facturación desde mesas)
 * - views/factura.ejs (impresión)
 * - services/stock.js (kardex)
 * - routes/stock.js (pantalla de inventario)
 */

async function columnExists(table, column) {
    const [rows] = await pool.query(
        `SELECT 1
         FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = ?
           AND COLUMN_NAME = ?
         LIMIT 1`,
        [table, column]
    );
    return rows.length > 0;
}

let schemaPromise = null;

async function ensureSchema() {
    if (!schemaPromise) {
        schemaPromise = ensureSchemaOnce().catch((err) => {
            schemaPromise = null;
            console.error('ensureSchema() falló:', err);
        });
    }
    return schemaPromise;
}

async function ensureSchemaOnce() {
    try {
        // Tabla de pagos por factura (pago mixto) — con soporte para QR
        await pool.query(`
            CREATE TABLE IF NOT EXISTS factura_pagos (
                id INT AUTO_INCREMENT PRIMARY KEY,
                factura_id INT NOT NULL,
                metodo ENUM('efectivo', 'transferencia', 'tarjeta', 'qr') NOT NULL,
                monto DECIMAL(10,2) NOT NULL,
                referencia VARCHAR(100) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (factura_id) REFERENCES facturas(id) ON DELETE CASCADE
            )
        `);

        // Migrar facturas.forma_pago: asegurar que incluya tarjeta, qr y mixto
        const [rowsFP] = await pool.query(
            `SELECT COLUMN_TYPE
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'facturas'
               AND COLUMN_NAME = 'forma_pago'
             LIMIT 1`
        );
        const fpType = rowsFP?.[0]?.COLUMN_TYPE || '';
        if (fpType && (!fpType.includes("'tarjeta'") || !fpType.includes("'qr'") || !fpType.includes("'mixto'"))) {
            await pool.query(
                `ALTER TABLE facturas
                 MODIFY forma_pago ENUM('efectivo','transferencia','tarjeta','qr','mixto') NOT NULL DEFAULT 'efectivo'`
            );
        }

        // Migrar factura_pagos.metodo: asegurar que incluya qr
        const [rowsMP] = await pool.query(
            `SELECT COLUMN_TYPE
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'factura_pagos'
               AND COLUMN_NAME = 'metodo'
             LIMIT 1`
        );
        const mpType = rowsMP?.[0]?.COLUMN_TYPE || '';
        if (mpType && !mpType.includes("'qr'")) {
            await pool.query(
                `ALTER TABLE factura_pagos
                 MODIFY metodo ENUM('efectivo','transferencia','tarjeta','qr') NOT NULL`
            );
        }

        // Inventario por producto. Los productos ya creados quedan con controla_stock = 0.
        if (!(await columnExists('productos', 'controla_stock'))) {
            await pool.query(`ALTER TABLE productos ADD COLUMN controla_stock TINYINT(1) NOT NULL DEFAULT 0`);
        }
        if (!(await columnExists('productos', 'stock_actual'))) {
            await pool.query(`ALTER TABLE productos ADD COLUMN stock_actual DECIMAL(10,2) NOT NULL DEFAULT 0`);
        }
        if (!(await columnExists('productos', 'stock_minimo'))) {
            await pool.query(`ALTER TABLE productos ADD COLUMN stock_minimo DECIMAL(10,2) NOT NULL DEFAULT 0`);
        }
        if (!(await columnExists('productos', 'unidad_stock'))) {
            await pool.query(`ALTER TABLE productos ADD COLUMN unidad_stock ENUM('KG','UND','LB') NOT NULL DEFAULT 'UND'`);
        }

        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_movimientos (
                id INT AUTO_INCREMENT PRIMARY KEY,
                producto_id INT NOT NULL,
                tipo ENUM('entrada','salida_cocina','devolucion','ajuste') NOT NULL,
                cantidad DECIMAL(10,2) NOT NULL,
                stock_anterior DECIMAL(10,2) NOT NULL,
                stock_nuevo DECIMAL(10,2) NOT NULL,
                pedido_item_id INT NULL,
                motivo VARCHAR(200) NULL,
                usuario_id INT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uk_stock_item_tipo (pedido_item_id, tipo),
                KEY idx_stock_producto (producto_id, id),
                FOREIGN KEY (producto_id) REFERENCES productos(id),
                FOREIGN KEY (pedido_item_id) REFERENCES pedido_items(id) ON DELETE SET NULL,
                FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE SET NULL
            )
        `);
    } catch (err) {
        // El wrapper registra el error y permite reintentar en el siguiente arranque.
        throw err;
    }
}

// Verificar la conexión
pool.getConnection()
    .then(connection => {
        console.log('Conexión exitosa a la base de datos');
        connection.release();
        // Intentar asegurar esquema al iniciar (mejora compatibilidad al actualizar el sistema)
        ensureSchema();
    })
    .catch(err => {
        console.error('Error al conectar a la base de datos:', err);
    });

pool.ensureSchema = ensureSchema;
module.exports = pool; 