const express = require('express');
const router = express.Router();
const db = require('../db');
const stock = require('../services/stock');

function usuarioActualId(req) {
    const id = Number(req.session?.user?.id);
    return Number.isFinite(id) && id > 0 ? id : null;
}

function responderStock(res, err, fallback) {
    if (err && err.name === 'StockError') {
        return res.status(err.status || 409).json({ error: err.message });
    }
    console.error(fallback, err);
    return res.status(500).json({ error: fallback });
}

router.get('/', (req, res) => {
    res.render('stock');
});

router.get('/api/productos', async (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        const filtro = String(req.query.filtro || 'todos');
        const params = [];
        let where = '1=1';
        if (q) {
            where += ' AND (nombre LIKE ? OR codigo LIKE ?)';
            params.push(`%${q}%`, `%${q}%`);
        }
        if (filtro === 'bajos') {
            where += ' AND controla_stock = 1 AND stock_actual > 0 AND stock_actual <= stock_minimo';
        } else if (filtro === 'agotados') {
            where += ' AND controla_stock = 1 AND stock_actual <= 0';
        } else if (filtro === 'sin_control') {
            where += ' AND controla_stock = 0';
        }

        const [productos] = await db.query(
            `SELECT id, codigo, nombre, controla_stock, stock_actual, stock_minimo, unidad_stock
             FROM productos
             WHERE ${where}
             ORDER BY nombre`,
            params
        );
        const [[resumen]] = await db.query(
            `SELECT
                SUM(controla_stock = 1) AS controlados,
                SUM(controla_stock = 1 AND stock_actual > 0 AND stock_actual <= stock_minimo) AS bajos,
                SUM(controla_stock = 1 AND stock_actual <= 0) AS agotados
             FROM productos`
        );
        res.json({
            productos,
            resumen: {
                controlados: Number(resumen?.controlados || 0),
                bajos: Number(resumen?.bajos || 0),
                agotados: Number(resumen?.agotados || 0)
            }
        });
    } catch (error) {
        console.error('Error al listar stock:', error);
        res.status(500).json({ error: 'Error al listar stock' });
    }
});

router.get('/api/movimientos', async (req, res) => {
    try {
        const productoId = Number(req.query.producto_id);
        if (!Number.isFinite(productoId) || productoId <= 0) {
            return res.status(400).json({ error: 'producto_id requerido' });
        }
        const [rows] = await db.query(
            `SELECT m.id, m.tipo, m.cantidad, m.stock_anterior, m.stock_nuevo, m.motivo, m.created_at,
                    u.usuario
             FROM stock_movimientos m
             LEFT JOIN usuarios u ON u.id = m.usuario_id
             WHERE m.producto_id = ?
             ORDER BY m.id DESC
             LIMIT 80`,
            [productoId]
        );
        res.json(rows);
    } catch (error) {
        console.error('Error al listar kardex:', error);
        res.status(500).json({ error: 'Error al listar movimientos' });
    }
});

router.post('/api/productos/:id/activar', async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const data = await stock.activar(connection, {
            productoId: Number(req.params.id),
            unidadStock: req.body?.unidad_stock,
            stockActual: req.body?.stock_actual,
            stockMinimo: req.body?.stock_minimo,
            usuarioId: usuarioActualId(req)
        });
        await connection.commit();
        res.json({ message: 'Control de stock activado', ...data });
    } catch (error) {
        await connection.rollback();
        responderStock(res, error, 'Error al activar el stock');
    } finally {
        connection.release();
    }
});

router.post('/api/productos/:id/desactivar', async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        await stock.desactivar(connection, Number(req.params.id));
        await connection.commit();
        res.json({ message: 'Control de stock desactivado' });
    } catch (error) {
        await connection.rollback();
        responderStock(res, error, 'Error al desactivar el stock');
    } finally {
        connection.release();
    }
});

router.post('/api/productos/:id/entrada', async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const data = await stock.entrada(connection, {
            productoId: Number(req.params.id),
            cantidad: req.body?.cantidad,
            motivo: req.body?.motivo,
            usuarioId: usuarioActualId(req)
        });
        await connection.commit();
        res.json({ message: 'Entrada registrada', ...data });
    } catch (error) {
        await connection.rollback();
        responderStock(res, error, 'Error al registrar la entrada');
    } finally {
        connection.release();
    }
});

router.post('/api/productos/:id/ajuste', async (req, res) => {
    const connection = await db.getConnection();
    try {
        await connection.beginTransaction();
        const data = await stock.ajuste(connection, {
            productoId: Number(req.params.id),
            stockNuevo: req.body?.stock_nuevo,
            motivo: req.body?.motivo,
            usuarioId: usuarioActualId(req)
        });
        await connection.commit();
        res.json({ message: 'Ajuste registrado', ...data });
    } catch (error) {
        await connection.rollback();
        responderStock(res, error, 'Error al registrar el ajuste');
    } finally {
        connection.release();
    }
});

module.exports = router;
