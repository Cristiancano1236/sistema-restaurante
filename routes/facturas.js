const express = require('express');
const router = express.Router();
const db = require('../db');

// Validar rutas de retorno (evitar open-redirect / URLs externas)
// Se usa para que el botón "Volver" de la impresión regrese a Mesas cuando aplique.
function safeReturnTo(value) {
    const v = String(value || '').trim();
    if (!v) return '/';
    // Solo permitimos paths relativos al sitio (inician con "/")
    if (!v.startsWith('/')) return '/';
    // Bloquear intentos tipo "//dominio.com" o backslashes
    if (v.startsWith('//') || v.includes('\\')) return '/';
    return v;
}

// Helpers de pagos (pago mixto)
// Relacionado con:
// - public/js/factura.js (envía pagos desde index)
// - public/js/mesas.js (envía pagos desde mesas)
function normalizarPagos(pagos) {
    if (!Array.isArray(pagos)) return [];
    return pagos
        .filter(p => p && typeof p === 'object')
        .map(p => ({
            metodo: String(p.metodo || '').toLowerCase().trim(),
            monto: Number(p.monto || 0),
            referencia: (p.referencia != null && String(p.referencia).trim() !== '') ? String(p.referencia).trim() : null
        }))
        .filter(p => ['efectivo', 'transferencia', 'tarjeta'].includes(p.metodo) && Number.isFinite(p.monto) && p.monto > 0);
}

function sumatoriaPagos(pagos) {
    return pagos.reduce((acc, p) => acc + Number(p.monto || 0), 0);
}

function almostEqualMoney(a, b) {
    // Tolerancia de 1 centavo para evitar problemas de flotantes
    return Math.abs(Number(a) - Number(b)) < 0.01;
}

// Crear nueva factura
router.post('/', async (req, res) => {
    const { cliente_id, total, forma_pago, productos, pagos } = req.body;
    
    console.log('Datos recibidos:', req.body);
    
    if (!cliente_id || !productos || productos.length === 0) {
        return res.status(400).json({ error: 'Datos incompletos' });
    }

    // Validaciones ANTES de abrir transacción (evita dejar conexiones abiertas si hay error)
    const totalNum = Number(total || 0);
    if (!Number.isFinite(totalNum) || totalNum <= 0) {
        return res.status(400).json({ error: 'Total inválido' });
    }

    // Si vienen pagos (pago mixto), validamos y definimos forma_pago compatible
    const pagosNorm = normalizarPagos(pagos);
    let formaPagoDB = (forma_pago || 'efectivo');
    if (pagosNorm.length > 0) {
        const suma = sumatoriaPagos(pagosNorm);
        if (!almostEqualMoney(suma, totalNum)) {
            return res.status(400).json({ error: 'La suma de pagos no coincide con el total' });
        }
        formaPagoDB = pagosNorm.length === 1 ? pagosNorm[0].metodo : 'mixto';
    } else {
        // Compatibilidad con flujo anterior (un solo medio)
        const fp = String(forma_pago || 'efectivo').toLowerCase();
        formaPagoDB = ['efectivo', 'transferencia', 'tarjeta', 'mixto'].includes(fp) ? fp : 'efectivo';
    }

    try {
        // Obtener conexión del pool
        const connection = await db.getConnection();
        
        try {
            // Iniciar transacción
            await connection.beginTransaction();

            // Insertar factura
            const [result] = await connection.query(
                'INSERT INTO facturas (cliente_id, total, forma_pago) VALUES (?, ?, ?)',
                [cliente_id, totalNum, formaPagoDB]
            );

            const factura_id = result.insertId;

            // Insertar detalles de factura
            const detallesValues = productos.map(p => [
                factura_id,
                p.producto_id,
                p.cantidad,
                p.precio,
                p.unidad,
                p.subtotal
            ]);

            await connection.query(
                'INSERT INTO detalle_factura (factura_id, producto_id, cantidad, precio_unitario, unidad_medida, subtotal) VALUES ?',
                [detallesValues]
            );

            // Guardar pagos (pago mixto) si existe la tabla factura_pagos
            // Relacionado con database.sql -> tabla factura_pagos
            try {
                if (pagosNorm.length > 0) {
                    const pagosValues = pagosNorm.map(p => ([factura_id, p.metodo, p.monto, p.referencia]));
                    await connection.query(
                        'INSERT INTO factura_pagos (factura_id, metodo, monto, referencia) VALUES ?',
                        [pagosValues]
                    );
                } else {
                    // Compatibilidad: crear 1 pago con el método seleccionado y el total
                    await connection.query(
                        'INSERT INTO factura_pagos (factura_id, metodo, monto, referencia) VALUES (?, ?, ?, ?)',
                        [factura_id, (formaPagoDB === 'mixto' ? 'efectivo' : formaPagoDB), totalNum, null]
                    );
                }
            } catch (_) {
                // Si la tabla no existe (instalación vieja), no rompemos la creación de factura
            }

            // Confirmar transacción
            await connection.commit();
            
            // Devolver la conexión al pool
            connection.release();
            
            res.status(201).json({ id: factura_id });

        } catch (error) {
            // Si hay error, hacer rollback
            await connection.rollback();
            // Devolver la conexión al pool
            connection.release();
            throw error; // Re-lanzar el error para que lo maneje el catch exterior
        }

    } catch (error) {
        console.error('Error al crear factura:', error);
        res.status(500).json({ error: 'Error al crear factura' });
    }
});

// Vista previa e impresión de factura
router.get('/:id/imprimir', async (req, res) => {
    const factura_id = req.params.id;
    const return_to = safeReturnTo(req.query.return_to);
    // Si se muestra dentro de un iframe/modal (index/ventas), ocultamos el botón "Volver"
    const embed = String(req.query.embed || '') === '1';

    try {
        // Obtener configuración
        const [configRows] = await db.query(
            'SELECT * FROM configuracion_impresion LIMIT 1'
        );

        if (!configRows || configRows.length === 0) {
            return res.status(400).json({ error: 'No se ha configurado la información de impresión' });
        }

        const config = configRows[0];

        // Convertir imágenes a formato data URL si existen
        if (config.logo_data) {
            const logoBuffer = Buffer.from(config.logo_data);
            config.logo_src = `data:image/${config.logo_tipo};base64,${logoBuffer.toString('base64')}`;
        }
        if (config.qr_data) {
            const qrBuffer = Buffer.from(config.qr_data);
            config.qr_src = `data:image/${config.qr_tipo};base64,${qrBuffer.toString('base64')}`;
        }

        // Obtener datos de la factura
        const [facturas] = await db.query(
            `SELECT f.*, c.nombre as cliente_nombre, c.direccion, c.telefono
             FROM facturas f
             JOIN clientes c ON f.cliente_id = c.id
             WHERE f.id = ?`,
            [factura_id]
        );

        if (!facturas || facturas.length === 0) {
            return res.status(404).json({ error: 'Factura no encontrada' });
        }

        // Obtener detalles de la factura
        const [detalles] = await db.query(
            `SELECT d.*, p.nombre as producto_nombre
             FROM detalle_factura d
             JOIN productos p ON d.producto_id = p.id
             WHERE d.factura_id = ?`,
            [factura_id]
        );

        // Obtener pagos de la factura (si existe la tabla)
        let pagos = [];
        try {
            const [pagosRows] = await db.query(
                `SELECT metodo, monto, referencia FROM factura_pagos WHERE factura_id = ? ORDER BY id ASC`,
                [factura_id]
            );
            pagos = pagosRows || [];
        } catch (_) {
            // Si no existe la tabla (instalaciones viejas), no rompemos la impresión
            pagos = [];
        }

        if (!detalles) {
            return res.status(404).json({ error: 'No se encontraron detalles de la factura' });
        }

        // Renderizar la vista de la factura
        res.render('factura', {
            factura: facturas[0],
            detalles: detalles,
            config: config,
            pagos: pagos,
            // Relacionado con: views/factura.ejs (botón Volver)
            return_to: return_to,
            // Relacionado con: index (modal) y ventas (reimprimir)
            embed: embed
        });

    } catch (error) {
        console.error('Error al obtener datos de factura:', error);
        res.status(500).json({ error: 'Error al obtener datos de factura' });
    }
});

// Ruta para obtener detalles de una factura
router.get('/:id/detalles', async (req, res) => {
    try {
        // Obtener información de la factura
        const [facturas] = await db.query(
            'SELECT f.*, c.nombre as cliente_nombre, c.direccion, c.telefono FROM facturas f ' +
            'JOIN clientes c ON f.cliente_id = c.id ' +
            'WHERE f.id = ?',
            [req.params.id]
        );

        if (facturas.length === 0) {
            return res.status(404).json({ error: 'Factura no encontrada' });
        }

        const factura = facturas[0];

        // Obtener productos de la factura
        const [productos] = await db.query(
            'SELECT d.cantidad, d.precio_unitario, d.unidad_medida, d.subtotal, p.nombre ' +
            'FROM detalle_factura d ' +
            'JOIN productos p ON d.producto_id = p.id ' +
            'WHERE d.factura_id = ?',
            [req.params.id]
        );

        // Obtener pagos (si existe tabla)
        let pagos = [];
        try {
            const [pagosRows] = await db.query(
                'SELECT metodo, monto, referencia FROM factura_pagos WHERE factura_id = ? ORDER BY id ASC',
                [req.params.id]
            );
            pagos = pagosRows || [];
        } catch (_) {
            pagos = [];
        }

        // Estructurar la respuesta asegurando que los valores numéricos sean válidos
        res.json({
            factura: {
                id: factura.id,
                fecha: factura.fecha,
                total: parseFloat(factura.total || 0),
                forma_pago: factura.forma_pago
            },
            cliente: {
                nombre: factura.cliente_nombre || '',
                direccion: factura.direccion || '',
                telefono: factura.telefono || ''
            },
            pagos: pagos.map(p => ({
                metodo: p.metodo,
                monto: parseFloat(p.monto || 0),
                referencia: p.referencia || ''
            })),
            productos: productos.map(p => ({
                nombre: p.nombre || '',
                cantidad: parseFloat(p.cantidad || 0),
                unidad: p.unidad_medida || '',
                precio: parseFloat(p.precio_unitario || 0),
                subtotal: parseFloat(p.subtotal || 0)
            }))
        });
    } catch (error) {
        console.error('Error al obtener detalles de la factura:', error);
        res.status(500).json({ error: 'Error al obtener detalles de la factura' });
    }
});

module.exports = router; 