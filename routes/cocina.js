const express = require('express');
const router = express.Router();
const db = require('../db');
const stock = require('../services/stock');

function usuarioActualId(req) {
    const id = Number(req.session?.user?.id);
    return Number.isFinite(id) && id > 0 ? id : null;
}
const { requireRole } = require('../middleware/auth');

// Rutas para la vista/cola de cocina
// - Renderiza pedidos/items en orden de envío (FIFO por enviado_at, luego created_at)
// - Permite avanzar estados: preparando -> listo -> servido

// GET /cocina - vista de cola de cocina
router.get('/', requireRole(['cocinero', 'mesero', 'administrador']), async (req, res) => {
    try {
        const [items] = await db.query(`
            SELECT i.*, p.mesa_id, p.mesero_nombre, m.numero AS mesa_numero, pr.nombre AS producto_nombre
            FROM pedido_items i
            JOIN pedidos p ON p.id = i.pedido_id
            JOIN mesas m ON m.id = p.mesa_id
            JOIN productos pr ON pr.id = i.producto_id
            WHERE i.estado IN ('enviado','preparando','listo')
            ORDER BY COALESCE(i.enviado_at, i.created_at) ASC, i.id ASC
        `);

        res.render('cocina', { items: items || [] });
    } catch (error) {
        console.error('Error al cargar cocina:', error);
        res.status(500).render('error', { error: { message: 'Error al cargar cocina', stack: error.stack } });
    }
});

// GET /cocina/cola - API: obtener cola de cocina
router.get('/cola', requireRole(['cocinero', 'mesero', 'administrador']), async (req, res) => {
    try {
        const [items] = await db.query(`
            SELECT i.*, p.mesa_id, p.mesero_nombre, m.numero AS mesa_numero, pr.nombre AS producto_nombre
            FROM pedido_items i
            JOIN pedidos p ON p.id = i.pedido_id
            JOIN mesas m ON m.id = p.mesa_id
            JOIN productos pr ON pr.id = i.producto_id
            WHERE i.estado IN ('enviado','preparando','listo')
            ORDER BY COALESCE(i.enviado_at, i.created_at) ASC, i.id ASC
        `);
        res.json(items);
    } catch (error) {
        console.error('Error al obtener cola:', error);
        res.status(500).json({ error: 'Error al obtener cola' });
    }
});

// GET /cocina/entregados - API: items entregados (servido) con filtro por fecha
// Parámetros:
// - desde=YYYY-MM-DD
// - hasta=YYYY-MM-DD
// Si no se envían, se puede filtrar desde el frontend (por defecto hoy).
// Relacionado con:
// - public/js/cocina.js (pestaña Entregados y filtros)
// - views/cocina.ejs (inputs de fecha)
router.get('/entregados', requireRole(['cocinero', 'mesero', 'administrador']), async (req, res) => {
    try {
        const desde = String(req.query.desde || '').trim();
        const hasta = String(req.query.hasta || '').trim();

        const where = [`i.estado = 'servido'`];
        const params = [];

        // Validación simple de formato (YYYY-MM-DD). Si no cumple, ignoramos filtro.
        const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
        if (isDate(desde) && isDate(hasta)) {
            where.push(`DATE(COALESCE(i.servido_at, i.updated_at, i.created_at)) BETWEEN ? AND ?`);
            params.push(desde, hasta);
        } else if (isDate(desde) && !isDate(hasta)) {
            where.push(`DATE(COALESCE(i.servido_at, i.updated_at, i.created_at)) >= ?`);
            params.push(desde);
        } else if (!isDate(desde) && isDate(hasta)) {
            where.push(`DATE(COALESCE(i.servido_at, i.updated_at, i.created_at)) <= ?`);
            params.push(hasta);
        }

        const [items] = await db.query(`
            SELECT i.*, p.mesa_id, p.mesero_nombre, m.numero AS mesa_numero, pr.nombre AS producto_nombre
            FROM pedido_items i
            JOIN pedidos p ON p.id = i.pedido_id
            JOIN mesas m ON m.id = p.mesa_id
            JOIN productos pr ON pr.id = i.producto_id
            WHERE ${where.join(' AND ')}
            ORDER BY COALESCE(i.servido_at, i.updated_at, i.created_at) DESC, i.id DESC
            LIMIT 500
        `, params);

        res.json(items || []);
    } catch (error) {
        console.error('Error al obtener entregados:', error);
        res.status(500).json({ error: 'Error al obtener entregados' });
    }
});

// GET /cocina/rechazados - API: items rechazados (rechazado) con filtro por fecha
// Parámetros:
// - desde=YYYY-MM-DD
// - hasta=YYYY-MM-DD
// Relacionado con:
// - public/js/cocina.js (pestaña Rechazados y filtros)
// - views/cocina.ejs (pestaña Rechazados)
// - routes/mesas.js (liberar mesa -> marca pedido/items como rechazados)
router.get('/rechazados', requireRole(['cocinero', 'mesero', 'administrador']), async (req, res) => {
    try {
        const desde = String(req.query.desde || '').trim();
        const hasta = String(req.query.hasta || '').trim();

        // Tomamos rechazados desde el item (i.estado) o desde el pedido (p.estado)
        // para soportar escenarios donde el item aún quedó 'cancelado' pero el pedido fue rechazado.
        const where = [`(i.estado = 'rechazado' OR p.estado = 'rechazado')`];
        const params = [];

        // Validación simple de formato (YYYY-MM-DD). Si no cumple, ignoramos filtro.
        const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
        if (isDate(desde) && isDate(hasta)) {
            where.push(`DATE(COALESCE(i.updated_at, i.created_at)) BETWEEN ? AND ?`);
            params.push(desde, hasta);
        } else if (isDate(desde) && !isDate(hasta)) {
            where.push(`DATE(COALESCE(i.updated_at, i.created_at)) >= ?`);
            params.push(desde);
        } else if (!isDate(desde) && isDate(hasta)) {
            where.push(`DATE(COALESCE(i.updated_at, i.created_at)) <= ?`);
            params.push(hasta);
        }

        const [items] = await db.query(`
            SELECT i.*, p.mesa_id, p.mesero_nombre, m.numero AS mesa_numero, pr.nombre AS producto_nombre
            FROM pedido_items i
            JOIN pedidos p ON p.id = i.pedido_id
            JOIN mesas m ON m.id = p.mesa_id
            JOIN productos pr ON pr.id = i.producto_id
            WHERE ${where.join(' AND ')}
            ORDER BY COALESCE(i.updated_at, i.created_at) DESC, i.id DESC
            LIMIT 500
        `, params);

        res.json(items || []);
    } catch (error) {
        console.error('Error al obtener rechazados:', error);
        res.status(500).json({ error: 'Error al obtener rechazados' });
    }
});

// PUT /cocina/item/:id/estado - API: actualizar estado de preparación
router.put('/item/:id/estado', requireRole(['cocinero', 'administrador']), async (req, res) => {
    try {
        const id = req.params.id;
        const { estado } = req.body || {};
        const permitidos = ['preparando','listo'];
        if (!permitidos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

        const timestampField = estado === 'preparando' ? 'preparado_at' : 'listo_at';
        const [result] = await db.query(
            `UPDATE pedido_items SET estado = ?, ${timestampField} = NOW() WHERE id = ? AND estado IN ('enviado','preparando')`,
            [estado, id]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Item no encontrado o en estado no válido' });
        res.json({ message: 'Estado actualizado' });
    } catch (error) {
        console.error('Error al actualizar estado en cocina:', error);
        res.status(500).json({ error: 'Error al actualizar estado' });
    }
});

// PUT /cocina/mesa/:mesaId/preparar - API: enviar a "preparando" todos los items "enviado" de una mesa
// Relacionado con:
// - public/js/cocina.js (botón "Preparar mesa" en pestaña Enviados)
// - views/cocina.ejs (render de tarjetas de Enviados)
router.put('/mesa/:mesaId/preparar', requireRole(['cocinero', 'administrador']), async (req, res) => {
    try {
        const mesaId = Number(req.params.mesaId);
        if (!Number.isInteger(mesaId) || mesaId <= 0) {
            return res.status(400).json({ error: 'Mesa inválida' });
        }

        // Actualiza todos los items "enviado" asociados a pedidos de la mesa.
        // Usamos JOIN para evitar tener que traer ids al backend en dos pasos.
        const [result] = await db.query(
            `UPDATE pedido_items i
             JOIN pedidos p ON p.id = i.pedido_id
             SET i.estado = 'preparando', i.preparado_at = NOW()
             WHERE p.mesa_id = ? AND i.estado = 'enviado'`,
            [mesaId]
        );

        if ((result?.affectedRows || 0) === 0) {
            return res.status(404).json({ error: 'No hay items enviados para preparar en esta mesa' });
        }

        res.json({ message: 'Mesa enviada a preparación', actualizados: result.affectedRows });
    } catch (error) {
        console.error('Error al preparar mesa en cocina:', error);
        res.status(500).json({ error: 'Error al preparar mesa' });
    }
});

// PUT /cocina/item/:id/rechazar - API: cancelar/rechazar item desde Cocina
// Relacionado con:
// - public/js/cocina.js (botón "Cancelar" en tabs Enviados/Preparando/Listos)
// - views/cocina.ejs (pestañas)
// - database.sql (estado pedido_items='rechazado')
router.put('/item/:id/rechazar', requireRole(['cocinero', 'administrador']), async (req, res) => {
    const connection = await db.getConnection();
    try {
        const id = req.params.id;
        await connection.beginTransaction();
        const [itemRows] = await connection.query(
            `SELECT i.id, i.producto_id, i.cantidad, i.unidad_medida, i.estado
             FROM pedido_items i
             WHERE i.id = ?
             LIMIT 1
             FOR UPDATE`,
            [id]
        );
        const actual = itemRows[0];
        const estadoPrevio = String(actual?.estado || '').toLowerCase();
        if (!actual || !['enviado', 'preparando', 'listo'].includes(estadoPrevio)) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ error: 'No se pudo rechazar: item no encontrado o en estado no válido' });
        }

        await stock.devolverPorItem(connection, actual, usuarioActualId(req));
        const [result] = await connection.query(
            `UPDATE pedido_items
             SET estado = 'rechazado'
             WHERE id = ? AND estado = ?`,
            [id, estadoPrevio]
        );
        if ((result?.affectedRows || 0) === 0) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({ error: 'No se pudo rechazar: item no encontrado o en estado no válido' });
        }

        await connection.commit();
        connection.release();
        res.json({ message: 'Item rechazado' });
    } catch (error) {
        try { await connection.rollback(); } catch (_) {}
        connection.release();
        console.error('Error al rechazar item en cocina:', error);
        if (error && error.name === 'StockError') {
            return res.status(error.status || 409).json({ error: error.message });
        }
        res.status(500).json({ error: 'Error al rechazar item' });
    }
});

module.exports = router;


