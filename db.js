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
 *
 * Relacionado con:
 * - routes/facturas.js (facturación desde index)
 * - routes/mesas.js (facturación desde mesas)
 * - views/factura.ejs (impresión)
 */
async function ensureSchema() {
    try {
        // Tabla de pagos por factura (pago mixto)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS factura_pagos (
                id INT AUTO_INCREMENT PRIMARY KEY,
                factura_id INT NOT NULL,
                metodo ENUM('efectivo', 'transferencia', 'tarjeta') NOT NULL,
                monto DECIMAL(10,2) NOT NULL,
                referencia VARCHAR(100) NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (factura_id) REFERENCES facturas(id) ON DELETE CASCADE
            )
        `);

        // Asegurar que el ENUM incluya tarjeta/mixto (si ya existe la tabla, CREATE TABLE no lo altera)
        const [rows] = await pool.query(
            `SELECT COLUMN_TYPE
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME = 'facturas'
               AND COLUMN_NAME = 'forma_pago'
             LIMIT 1`
        );

        const columnType = rows?.[0]?.COLUMN_TYPE || '';
        const needsTarjeta = !columnType.includes("'tarjeta'");
        const needsMixto = !columnType.includes("'mixto'");

        if (columnType && (needsTarjeta || needsMixto)) {
            await pool.query(
                `ALTER TABLE facturas
                 MODIFY forma_pago ENUM('efectivo','transferencia','tarjeta','mixto') NOT NULL DEFAULT 'efectivo'`
            );
        }
    } catch (err) {
        // No bloqueamos el arranque si falla el "auto-migrate", pero lo dejamos en consola.
        console.error('ensureSchema() falló:', err);
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

module.exports = pool; 