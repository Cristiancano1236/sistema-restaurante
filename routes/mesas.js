const express = require('express');
const router = express.Router();
const db = require('../db');

// Rutas para gestión de mesas y pedidos de restaurante
// - Renderiza la vista de mesas (GET /mesas)
// - Expone endpoints para abrir pedidos por mesa, agregar items y enviarlos a cocina
// - Se monta en server.js tanto en '/mesas' como en '/api/mesas'

// GET /mesas - Página de gestión de mesas
router.get('/', async (req, res) => {
    try {
        // Trae el listado de mesas y si tienen pedidos abiertos (para mostrar estado)
        const [mesas] = await db.query(`
            SELECT m.*, (
                SELECT COUNT(*) FROM pedidos p 
                WHERE p.mesa_id = m.id AND p.estado NOT IN ('cerrado','cancelado')
            ) AS pedidos_abiertos
            FROM mesas m
            ORDER BY m.numero
        `);

        res.render('mesas', { mesas: mesas || [] });
    } catch (error) {
        console.error('Error al cargar mesas:', error);
        res.status(500).render('error', { 
            error: { message: 'Error al cargar mesas', stack: error.stack }
        });
    }
});

// GET /mesas/listar - API: lista de mesas con estado actual
router.get('/listar', async (req, res) => {
    try {
        const [mesas] = await db.query(`
            SELECT m.*, (
                SELECT COUNT(*) FROM pedidos p 
                WHERE p.mesa_id = m.id AND p.estado NOT IN ('cerrado','cancelado')
            ) AS pedidos_abiertos
            FROM mesas m
            ORDER BY m.numero
        `);
        res.json(mesas);
    } catch (error) {
        console.error('Error al listar mesas:', error);
        res.status(500).json({ error: 'Error al listar mesas' });
    }
});

// POST /mesas/crear - API: crear mesa (opcional, para administración rápida)
router.post('/crear', async (req, res) => {
    try {
        const { numero, descripcion } = req.body || {};
        if (!numero) return res.status(400).json({ error: 'El número de mesa es requerido' });
        const [result] = await db.query(
            'INSERT INTO mesas (numero, descripcion, estado) VALUES (?, ?, ?)',
            [String(numero), descripcion || null, 'libre']
        );
        res.status(201).json({ id: result.insertId });
    } catch (error) {
        console.error('Error al crear mesa:', error);
        res.status(500).json({ error: 'Error al crear mesa' });
    }
});

// POST /mesas/abrir - API: abre (o recupera) pedido abierto para una mesa
router.post('/abrir', async (req, res) => {
    const { mesa_id, cliente_id, notas } = req.body || {};
    if (!mesa_id) return res.status(400).json({ error: 'mesa_id requerido' });
    try {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            const [existentes] = await connection.query(
                `SELECT * FROM pedidos WHERE mesa_id = ? AND estado NOT IN ('cerrado','cancelado') LIMIT 1`,
                [mesa_id]
            );
            if (existentes.length > 0) {
                await connection.commit();
                connection.release();
                return res.json({ pedido: existentes[0] });
            }

            const [insert] = await connection.query(
                `INSERT INTO pedidos (mesa_id, cliente_id, estado, total, notas) VALUES (?, ?, 'abierto', 0, ?)` ,
                [mesa_id, cliente_id || null, notas || null]
            );

            await connection.query(
                `UPDATE mesas SET estado = 'ocupada' WHERE id = ?`,
                [mesa_id]
            );

            await connection.commit();
            connection.release();
            res.status(201).json({ pedido: { id: insert.insertId, mesa_id, cliente_id: cliente_id || null, estado: 'abierto', total: 0, notas: notas || null } });
        } catch (error) {
            await connection.rollback();
            connection.release();
            throw error;
        }
    } catch (error) {
        console.error('Error al abrir pedido:', error);
        res.status(500).json({ error: 'Error al abrir pedido' });
    }
});

// GET /mesas/pedidos/:pedidoId - API: obtener pedido con items
router.get('/pedidos/:pedidoId', async (req, res) => {
    try {
        const pedidoId = req.params.pedidoId;
        const [pedidos] = await db.query('SELECT * FROM pedidos WHERE id = ?', [pedidoId]);
        if (pedidos.length === 0) return res.status(404).json({ error: 'Pedido no encontrado' });
        const pedido = pedidos[0];
        const [items] = await db.query(`
            SELECT i.*, p.nombre AS producto_nombre 
            FROM pedido_items i
            JOIN productos p ON p.id = i.producto_id
            WHERE i.pedido_id = ?
            ORDER BY i.created_at ASC
        `, [pedidoId]);
        res.json({ pedido, items });
    } catch (error) {
        console.error('Error al obtener pedido:', error);
        res.status(500).json({ error: 'Error al obtener pedido' });
    }
});

// POST /mesas/pedidos/:pedidoId/items - API: agregar item al pedido
router.post('/pedidos/:pedidoId/items', async (req, res) => {
    try {
        const pedidoId = req.params.pedidoId;
        const { producto_id, cantidad, unidad, precio, nota } = req.body || {};
        if (!producto_id || !cantidad || !precio) {
            return res.status(400).json({ error: 'producto_id, cantidad y precio son requeridos' });
        }
        const subtotal = Number(cantidad) * Number(precio);
        const [result] = await db.query(
            `INSERT INTO pedido_items (pedido_id, producto_id, cantidad, unidad_medida, precio_unitario, subtotal, estado, nota)
             VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?)` ,
            [pedidoId, producto_id, cantidad, unidad || 'UND', precio, subtotal, nota || null]
        );
        res.status(201).json({ id: result.insertId });
    } catch (error) {
        console.error('Error al agregar item:', error);
        res.status(500).json({ error: 'Error al agregar item' });
    }
});

// DELETE /mesas/items/:itemId - API: eliminar item del pedido
// Relacionado con: public/js/mesas.js (función eliminarItem)
// IMPORTANTE: Esta ruta debe ir ANTES de las rutas PUT más específicas para evitar conflictos
router.delete('/items/:itemId', async (req, res) => {
    try {
        const itemId = req.params.itemId;
        console.log(`DELETE /api/mesas/items/${itemId} - Eliminando item`);
        const [result] = await db.query(
            `DELETE FROM pedido_items WHERE id = ?`,
            [itemId]
        );
        if (result.affectedRows === 0) {
            console.log(`Item ${itemId} no encontrado`);
            return res.status(404).json({ error: 'Item no encontrado' });
        }
        console.log(`Item ${itemId} eliminado exitosamente`);
        res.json({ message: 'Item eliminado' });
    } catch (error) {
        console.error('Error al eliminar item:', error);
        res.status(500).json({ error: 'Error al eliminar item' });
    }
});

// PUT /mesas/items/:itemId/enviar - API: enviar item a cocina
router.put('/items/:itemId/enviar', async (req, res) => {
    try {
        const itemId = req.params.itemId;
        const [result] = await db.query(
            `UPDATE pedido_items SET estado = 'enviado', enviado_at = NOW() WHERE id = ?`,
            [itemId]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Item no encontrado' });
        res.json({ message: 'Item enviado a cocina' });
    } catch (error) {
        console.error('Error al enviar item:', error);
        res.status(500).json({ error: 'Error al enviar item' });
    }
});

// PUT /mesas/items/:itemId/estado - API: actualizar estado de item (preparando, listo, servido, cancelado)
router.put('/items/:itemId/estado', async (req, res) => {
    try {
        const itemId = req.params.itemId;
        const { estado } = req.body || {};
        const permitidos = ['pendiente','enviado','preparando','listo','servido','cancelado'];
        if (!permitidos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

        let timestampField = null;
        if (estado === 'preparando') timestampField = 'preparado_at';
        if (estado === 'listo') timestampField = 'listo_at';
        if (estado === 'servido') timestampField = 'servido_at';

        if (timestampField) {
            await db.query(
                `UPDATE pedido_items SET estado = ?, ${timestampField} = NOW() WHERE id = ?`,
                [estado, itemId]
            );
        } else {
            await db.query(
                `UPDATE pedido_items SET estado = ? WHERE id = ?`,
                [estado, itemId]
            );
        }

        res.json({ message: 'Estado actualizado' });
    } catch (error) {
        console.error('Error al actualizar estado de item:', error);
        res.status(500).json({ error: 'Error al actualizar estado' });
    }
});

// POST /mesas/pedidos/:pedidoId/facturar - API: genera factura desde pedido y cierra mesa
router.post('/pedidos/:pedidoId/facturar', async (req, res) => {
    const pedidoId = req.params.pedidoId;
    const { cliente_id, forma_pago } = req.body || {};
    if (!cliente_id) return res.status(400).json({ error: 'cliente_id requerido para facturar' });
    if (!forma_pago) return res.status(400).json({ error: 'forma_pago requerido' });
    try {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            const [pedidos] = await connection.query('SELECT * FROM pedidos WHERE id = ? FOR UPDATE', [pedidoId]);
            if (pedidos.length === 0) throw new Error('Pedido no encontrado');
            const pedido = pedidos[0];

            const [items] = await connection.query(
                `SELECT * FROM pedido_items WHERE pedido_id = ? AND estado <> 'cancelado'`,
                [pedidoId]
            );
            if (items.length === 0) throw new Error('Pedido sin items');

            const total = items.reduce((acc, it) => acc + Number(it.subtotal || 0), 0);

            const [facturaInsert] = await connection.query(
                `INSERT INTO facturas (cliente_id, total, forma_pago) VALUES (?, ?, ?)`,
                [cliente_id, total, forma_pago]
            );
            const facturaId = facturaInsert.insertId;

            const detallesValues = items.map(i => [
                facturaId,
                i.producto_id,
                i.cantidad,
                i.precio_unitario,
                i.unidad_medida,
                i.subtotal
            ]);
            await connection.query(
                `INSERT INTO detalle_factura (factura_id, producto_id, cantidad, precio_unitario, unidad_medida, subtotal) VALUES ?`,
                [detallesValues]
            );

            await connection.query(`UPDATE pedidos SET estado = 'cerrado', total = ? WHERE id = ?`, [total, pedidoId]);
            await connection.query(`UPDATE mesas SET estado = 'libre' WHERE id = ?`, [pedido.mesa_id]);

            await connection.commit();
            connection.release();
            res.status(201).json({ factura_id: facturaId });
        } catch (error) {
            await connection.rollback();
            connection.release();
            console.error('Error en facturación desde pedido:', error);
            res.status(500).json({ error: 'Error al facturar pedido' });
        }
    } catch (error) {
        console.error('Error al preparar facturación:', error);
        res.status(500).json({ error: 'Error interno' });
    }
});

// PUT /mesas/pedidos/:pedidoId/mover - Mover pedido a otra mesa (si está libre)
router.put('/pedidos/:pedidoId/mover', async (req, res) => {
    const pedidoId = req.params.pedidoId;
    const { mesa_destino_id } = req.body || {};
    if (!mesa_destino_id) return res.status(400).json({ error: 'mesa_destino_id requerido' });
    try {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            // Lock pedido
            const [pedidos] = await connection.query('SELECT * FROM pedidos WHERE id = ? FOR UPDATE', [pedidoId]);
            if (pedidos.length === 0) throw new Error('Pedido no encontrado');
            const pedido = pedidos[0];

            // Validar que el destino esté libre: sin pedidos abiertos
            const [abiertosDestino] = await connection.query(
                `SELECT COUNT(*) as cnt FROM pedidos WHERE mesa_id = ? AND estado NOT IN ('cerrado','cancelado')`,
                [mesa_destino_id]
            );
            if ((abiertosDestino[0]?.cnt || 0) > 0) {
                throw new Error('La mesa destino tiene un pedido activo');
            }

            // Actualizar estados de mesas (origen puede quedar ocupada si tuviera otros pedidos, pero por defecto quedará libre)
            await connection.query('UPDATE pedidos SET mesa_id = ? WHERE id = ?', [mesa_destino_id, pedidoId]);

            // Poner libre la mesa origen si no le quedan pedidos abiertos
            const [restantesOrigen] = await connection.query(
                `SELECT COUNT(*) as cnt FROM pedidos WHERE mesa_id = ? AND estado NOT IN ('cerrado','cancelado')`,
                [pedido.mesa_id]
            );
            if ((restantesOrigen[0]?.cnt || 0) === 0) {
                await connection.query('UPDATE mesas SET estado = "libre" WHERE id = ?', [pedido.mesa_id]);
            }

            // Poner ocupada la mesa destino
            await connection.query('UPDATE mesas SET estado = "ocupada" WHERE id = ?', [mesa_destino_id]);

            await connection.commit();
            connection.release();
            res.json({ message: 'Pedido movido', mesa_origen_id: pedido.mesa_id, mesa_destino_id });
        } catch (error) {
            await connection.rollback();
            connection.release();
            console.error('Error al mover pedido:', error);
            res.status(400).json({ error: error.message || 'Error al mover pedido' });
        }
    } catch (error) {
        console.error('Error interno al mover pedido:', error);
        res.status(500).json({ error: 'Error interno' });
    }
});

// PUT /mesas/:mesaId/liberar - Libera mesa si no tiene items en pedidos abiertos
router.put('/:mesaId/liberar', async (req, res) => {
    const mesaId = req.params.mesaId;
    try {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            // Revisar pedidos abiertos en esa mesa
            const [abiertos] = await connection.query(
                `SELECT p.id FROM pedidos p WHERE p.mesa_id = ? AND p.estado NOT IN ('cerrado','cancelado') FOR UPDATE`,
                [mesaId]
            );

            if (abiertos.length > 0) {
                // Verificar que no tengan items distintos de cancelado
                const ids = abiertos.map(p => p.id);
                const [items] = await connection.query(
                    `SELECT COUNT(*) as cnt FROM pedido_items WHERE pedido_id IN (?) AND estado <> 'cancelado'`,
                    [ids]
                );
                if ((items[0]?.cnt || 0) > 0) {
                    throw new Error('La mesa tiene items activos, no se puede liberar');
                }
                // Si no hay items activos, podemos marcar esos pedidos como cancelados
                await connection.query(`UPDATE pedidos SET estado = 'cancelado' WHERE id IN (?)`, [ids]);
            }

            await connection.query(`UPDATE mesas SET estado = 'libre' WHERE id = ?`, [mesaId]);
            await connection.commit();
            connection.release();
            res.json({ message: 'Mesa liberada' });
        } catch (error) {
            await connection.rollback();
            connection.release();
            console.error('Error al liberar mesa:', error);
            res.status(400).json({ error: error.message || 'Error al liberar mesa' });
        }
    } catch (error) {
        console.error('Error interno al liberar mesa:', error);
        res.status(500).json({ error: 'Error interno' });
    }
});

module.exports = router;


