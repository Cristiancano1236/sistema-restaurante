const express = require('express');
const router = express.Router();
const db = require('../db');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

// Rutas para gestión de mesas y pedidos de restaurante
// - Renderiza la vista de mesas (GET /mesas)
// - Expone endpoints para abrir pedidos por mesa, agregar items y enviarlos a cocina
// - Se monta en server.js tanto en '/mesas' como en '/api/mesas'

// Sincroniza estado de mesa en función de items activos:
// - Si no hay items activos en pedidos abiertos => libre
// - Si hay items activos => ocupada
// Relacionado con:
// - views/mesas.ejs (badge de estado)
// - public/js/mesas.js (refreshMesas)
// - requerimiento funcional: evitar mesas "ocupadas" sin productos
async function syncMesaEstadoByItems(connection, mesaId) {
    const [rows] = await connection.query(
        `SELECT COUNT(*) AS cnt
         FROM pedido_items i
         JOIN pedidos p ON p.id = i.pedido_id
         WHERE p.mesa_id = ?
           AND p.estado NOT IN ('cerrado','cancelado','rechazado')
           AND i.estado NOT IN ('cancelado','rechazado')`,
        [mesaId]
    );
    const activos = Number(rows?.[0]?.cnt || 0);
    await connection.query(
        `UPDATE mesas
         SET estado = ?
         WHERE id = ?
           AND estado IN ('libre','ocupada')`,
        [activos > 0 ? 'ocupada' : 'libre', mesaId]
    );
}

// Obtiene mesa_id de un item para operaciones posteriores (ej. sincronizar estado).
// Relacionado con: syncMesaEstadoByItems() y rutas de actualización/eliminación de items.
async function getMesaIdByItem(connection, itemId) {
    const [rows] = await connection.query(
        `SELECT p.mesa_id
         FROM pedido_items i
         JOIN pedidos p ON p.id = i.pedido_id
         WHERE i.id = ?
         LIMIT 1`,
        [itemId]
    );
    if (!rows.length) return null;
    return rows[0].mesa_id;
}

// Configuración operativa de Cocina:
// - auto_listo_comanda: al enviar desde Mesas el item pasa directo a "listo".
// - imprime_servidor: la comanda se imprime en el servidor (no en el navegador del celular).
async function getEnvioCocinaConfig(executor) {
    const q = executor && typeof executor.query === 'function' ? executor : db;
    try {
        const [rows] = await q.query(
            `SELECT cocina_auto_listo_comanda, cocina_imprime_servidor, impresora_comandas
             FROM configuracion_impresion
             LIMIT 1`
        );
        return {
            auto_listo_comanda: Number(rows?.[0]?.cocina_auto_listo_comanda || 0) === 1,
            imprime_servidor: Number(rows?.[0]?.cocina_imprime_servidor || 0) === 1,
            impresora_comandas: String(rows?.[0]?.impresora_comandas || '').trim() || null
        };
    } catch (e) {
        // Compatibilidad con instalaciones donde aún no existe alguna columna nueva.
        if (String(e?.code || '') === 'ER_BAD_FIELD_ERROR') {
            const [rows] = await q.query('SELECT cocina_auto_listo_comanda FROM configuracion_impresion LIMIT 1');
            return {
                auto_listo_comanda: Number(rows?.[0]?.cocina_auto_listo_comanda || 0) === 1,
                imprime_servidor: false,
                impresora_comandas: null
            };
        }
        throw e;
    }
}

function buildComandaTexto({ pedido, items, negocio }) {
    const line = '-'.repeat(42);
    const lines = [];
    lines.push(String(negocio || 'COMANDA'));
    lines.push(line);
    lines.push(`Mesa: ${pedido?.mesa_numero ?? '-'}`);
    lines.push(`Mesero: ${pedido?.mesero_nombre || 'Sin asignar'}`);
    lines.push(`Fecha: ${new Date().toLocaleString('es-CO')}`);
    lines.push(`Pedido: #${pedido?.id ?? '-'}`);
    lines.push(line);
    (items || []).forEach((it) => {
        lines.push(`x${Number(it?.cantidad || 0)} ${String(it?.producto_nombre || '')}`);
        const nota = String(it?.nota || '').trim();
        if (nota) lines.push(`  Obs: ${nota}`);
    });
    lines.push(line);
    lines.push('Fin de comanda');
    return lines.join('\r\n');
}

function execCommand(command) {
    return new Promise((resolve, reject) => {
        exec(command, { timeout: 25000 }, (error, stdout, stderr) => {
            if (error) return reject(new Error(String(stderr || error.message || 'Error al ejecutar comando de impresión')));
            resolve({ stdout, stderr });
        });
    });
}

// Construye el script PowerShell que usa System.Drawing.Printing.PrintDocument
// para imprimir en papel térmico con el tamaño de papel correcto.
// SIN esto, Out-Printer usa carta/A4 y el texto queda microscópico en papel de 80mm.
// Relacionado con: imprimirTextoEnServidor (abajo), imprimirTextoServidor en facturas.js
function buildThermalPsScript(psPath, psPrinter, anchoMm, fontSize) {
    // 1 pulgada = 25.4 mm. PaperSize trabaja en centésimas de pulgada.
    const widthH = Math.round(Number(anchoMm || 80) * 100 / 25.4);
    // Fuente monoespaciada; tamaño depende de config (1=8.5pt normal, 2=10pt grande)
    const pt = Number(fontSize || 1) === 2 ? '10' : '8.5';

    const lines = [
        'Add-Type -AssemblyName System.Drawing',
        "$script:ls = [System.IO.File]::ReadAllLines('" + psPath + "', [System.Text.Encoding]::UTF8)",
        '$script:i = 0',
        '$pd = New-Object System.Drawing.Printing.PrintDocument',
    ];
    if (psPrinter) {
        lines.push("$pd.PrinterSettings.PrinterName = '" + psPrinter + "'");
    }
    lines.push(
        '$ps = New-Object System.Drawing.Printing.PaperSize("ThermalTicket", ' + widthH + ', 2000)',
        '$pd.DefaultPageSettings.PaperSize = $ps',
        '$pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(10, 10, 10, 0)',
        '$script:fn = New-Object System.Drawing.Font("Courier New", ' + pt + ')',
        '$pd.add_PrintPage({',
        '    param($s, $e)',
        '    $y = [float]0',
        '    $lh = [float]$script:fn.GetHeight($e.Graphics)',
        '    while ($script:i -lt $script:ls.Length) {',
        '        $e.Graphics.DrawString($script:ls[$script:i], $script:fn, [System.Drawing.Brushes]::Black, [float]0, $y)',
        '        $y += $lh',
        '        $script:i++',
        '        if (($y + $lh) -gt [float]$e.MarginBounds.Height) { $e.HasMorePages = ($script:i -lt $script:ls.Length); break }',
        '    }',
        '})',
        '$pd.Print()',
        '$script:fn.Dispose()',
        '$pd.Dispose()'
    );
    return lines.join('\r\n');
}

// Imprime texto plano en la impresora del servidor (comanda).
// anchoPapelMm: ancho del rollo térmico en mm (58 o 80), viene de configuracion_impresion.
// fontSize: 1=normal, 2=grande (idem config).
// Relacionado con: POST /pedidos/:id/comanda/imprimir-servidor
async function imprimirTextoEnServidor(texto, impresoraNombre, anchoPapelMm, fontSize) {
    const tmpFile = path.join(
        os.tmpdir(),
        `comanda-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
    );
    // BOM UTF-8 para que ReadAllLines de .NET lo lea correctamente en Windows
    const bom  = Buffer.from([0xEF, 0xBB, 0xBF]);
    const body = Buffer.from(String(texto || ''), 'utf8');
    fs.writeFileSync(tmpFile, Buffer.concat([bom, body]));

    try {
        if (process.platform === 'win32') {
            const psPath    = tmpFile.replace(/'/g, "''");
            const psPrinter = String(impresoraNombre || '').trim().replace(/'/g, "''");
            const psScript  = buildThermalPsScript(psPath, psPrinter, anchoPapelMm, fontSize);
            // EncodedCommand (Base64 UTF-16LE) evita problemas de encoding en cmd.exe
            const encoded   = Buffer.from(psScript, 'utf16le').toString('base64');
            await execCommand('powershell -NoProfile -NonInteractive -EncodedCommand ' + encoded);
            return;
        }
        // Linux / macOS — CUPS
        const quoted = '"' + tmpFile.replace(/"/g, '\\"') + '"';
        const p      = String(impresoraNombre || '').trim();
        await execCommand(p ? 'lp -d "' + p.replace(/"/g, '\\"') + '" ' + quoted : 'lp ' + quoted);
    } finally {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
    }
}

// GET /mesas - Página de gestión de mesas
router.get('/', async (req, res) => {
    try {
        // Trae el listado de mesas y si tienen pedidos abiertos (para mostrar estado)
        const [mesas] = await db.query(`
            SELECT m.*,
            (
                -- Conteo de pedidos realmente activos (con al menos 1 item activo).
                -- Evita bloquear mesas solo por abrir comanda vacía.
                SELECT COUNT(DISTINCT p.id)
                FROM pedidos p
                JOIN pedido_items i ON i.pedido_id = p.id
                WHERE p.mesa_id = m.id
                  AND p.estado NOT IN ('cerrado','cancelado','rechazado')
                  AND i.estado NOT IN ('cancelado','rechazado')
            ) AS pedidos_abiertos,
            (
                SELECT COUNT(*)
                FROM pedido_items i
                JOIN pedidos p2 ON p2.id = i.pedido_id
                WHERE p2.mesa_id = m.id
                  AND p2.estado NOT IN ('cerrado','cancelado','rechazado')
                  AND i.estado NOT IN ('cancelado','rechazado')
            ) AS items_activos,
            CASE
                WHEN m.estado IN ('reservada','bloqueada') THEN m.estado
                WHEN (
                    SELECT COUNT(*)
                    FROM pedido_items i2
                    JOIN pedidos p3 ON p3.id = i2.pedido_id
                    WHERE p3.mesa_id = m.id
                      AND p3.estado NOT IN ('cerrado','cancelado','rechazado')
                      AND i2.estado NOT IN ('cancelado','rechazado')
                ) > 0 THEN 'ocupada'
                ELSE 'libre'
            END AS estado
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
            SELECT m.*,
            (
                -- Conteo de pedidos realmente activos (con al menos 1 item activo).
                -- Evita bloquear mesas solo por abrir comanda vacía.
                SELECT COUNT(DISTINCT p.id)
                FROM pedidos p
                JOIN pedido_items i ON i.pedido_id = p.id
                WHERE p.mesa_id = m.id
                  AND p.estado NOT IN ('cerrado','cancelado','rechazado')
                  AND i.estado NOT IN ('cancelado','rechazado')
            ) AS pedidos_abiertos,
            (
                SELECT COUNT(*)
                FROM pedido_items i
                JOIN pedidos p2 ON p2.id = i.pedido_id
                WHERE p2.mesa_id = m.id
                  AND p2.estado NOT IN ('cerrado','cancelado','rechazado')
                  AND i.estado NOT IN ('cancelado','rechazado')
            ) AS items_activos,
            CASE
                WHEN m.estado IN ('reservada','bloqueada') THEN m.estado
                WHEN (
                    SELECT COUNT(*)
                    FROM pedido_items i2
                    JOIN pedidos p3 ON p3.id = i2.pedido_id
                    WHERE p3.mesa_id = m.id
                      AND p3.estado NOT IN ('cerrado','cancelado','rechazado')
                      AND i2.estado NOT IN ('cancelado','rechazado')
                ) > 0 THEN 'ocupada'
                ELSE 'libre'
            END AS estado
            FROM mesas m
            ORDER BY m.numero
        `);
        res.json(mesas);
    } catch (error) {
        console.error('Error al listar mesas:', error);
        res.status(500).json({ error: 'Error al listar mesas' });
    }
});

// GET /mesas/config/envio-cocina - API: flags del flujo de envío a cocina
// Relacionado con: public/js/mesas.js (botón "Enviar a cocina")
router.get('/config/envio-cocina', async (req, res) => {
    try {
        const conf = await getEnvioCocinaConfig();
        res.json({
            auto_listo_comanda: !!conf.auto_listo_comanda,
            imprime_servidor: !!conf.imprime_servidor
        });
    } catch (error) {
        console.error('Error al leer configuración de envío a cocina:', error);
        res.status(500).json({ error: 'Error al leer configuración de envío a cocina' });
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

// PUT /mesas/:mesaId - API: editar mesa (numero/descripcion/estado)
router.put('/:mesaId', async (req, res) => {
    try {
        const mesaId = req.params.mesaId;
        const { numero, descripcion, estado } = req.body || {};

        if (!numero) return res.status(400).json({ error: 'El número de mesa es requerido' });

        const estadosPermitidos = ['libre', 'ocupada', 'reservada', 'bloqueada'];
        if (estado && !estadosPermitidos.includes(estado)) {
            return res.status(400).json({ error: 'Estado inválido' });
        }

        // Validar existencia
        const [actual] = await db.query('SELECT id FROM mesas WHERE id = ?', [mesaId]);
        if (actual.length === 0) return res.status(404).json({ error: 'Mesa no encontrada' });

        // Validar número único
        const [duplicada] = await db.query('SELECT id FROM mesas WHERE numero = ? AND id <> ?', [String(numero), mesaId]);
        if (duplicada.length > 0) {
            return res.status(409).json({ error: 'Ya existe una mesa con ese número' });
        }

        await db.query(
            'UPDATE mesas SET numero = ?, descripcion = ?, estado = COALESCE(?, estado) WHERE id = ?',
            [String(numero), descripcion || null, estado || null, mesaId]
        );

        res.json({ message: 'Mesa actualizada' });
    } catch (error) {
        console.error('Error al editar mesa:', error);
        res.status(500).json({ error: 'Error al editar mesa' });
    }
});

// DELETE /mesas/:mesaId - API: eliminar mesa (solo si no tiene pedidos asociados)
router.delete('/:mesaId', async (req, res) => {
    try {
        const mesaId = req.params.mesaId;

        const [existe] = await db.query('SELECT id FROM mesas WHERE id = ?', [mesaId]);
        if (existe.length === 0) return res.status(404).json({ error: 'Mesa no encontrada' });

        const [pedidos] = await db.query('SELECT COUNT(*) AS cnt FROM pedidos WHERE mesa_id = ?', [mesaId]);
        const cnt = Number(pedidos?.[0]?.cnt || 0);
        if (cnt > 0) {
            return res.status(400).json({ error: 'No se puede eliminar: la mesa tiene pedidos asociados' });
        }

        const [result] = await db.query('DELETE FROM mesas WHERE id = ?', [mesaId]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Mesa no encontrada' });

        res.json({ message: 'Mesa eliminada' });
    } catch (error) {
        console.error('Error al eliminar mesa:', error);
        res.status(500).json({ error: 'Error al eliminar mesa' });
    }
});

// POST /mesas/abrir - API: abre (o recupera) pedido abierto para una mesa
router.post('/abrir', async (req, res) => {
    const { mesa_id, cliente_id, notas } = req.body || {};
    if (!mesa_id) return res.status(400).json({ error: 'mesa_id requerido' });
    const meseroNombre = String(req.session?.user?.nombre || req.session?.user?.usuario || '').trim() || null;
    try {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            const [existentes] = await connection.query(
                // Nota: 'rechazado' NO es pedido activo; no se debe reutilizar al abrir
                // Relacionado con: estado "rechazado" (database.sql)
                `SELECT * FROM pedidos WHERE mesa_id = ? AND estado NOT IN ('cerrado','cancelado','rechazado') LIMIT 1`,
                [mesa_id]
            );
            if (existentes.length > 0) {
                // Si el pedido abierto aún no tiene mesero asignado, lo completamos con el usuario en sesión.
                if (!String(existentes[0]?.mesero_nombre || '').trim() && meseroNombre) {
                    await connection.query(
                        `UPDATE pedidos SET mesero_nombre = ? WHERE id = ?`,
                        [meseroNombre, existentes[0].id]
                    );
                    existentes[0].mesero_nombre = meseroNombre;
                }
                await syncMesaEstadoByItems(connection, mesa_id);
                const conf = await getEnvioCocinaConfig(connection);
                await connection.commit();
                connection.release();
                return res.json({
                    pedido: existentes[0],
                    auto_listo_comanda: !!conf.auto_listo_comanda,
                    imprime_servidor: !!conf.imprime_servidor
                });
            }

            const [insert] = await connection.query(
                `INSERT INTO pedidos (mesa_id, cliente_id, mesero_nombre, estado, total, notas) VALUES (?, ?, ?, 'abierto', 0, ?)` ,
                [mesa_id, cliente_id || null, meseroNombre, notas || null]
            );

            // Importante: abrir pedido no fuerza "ocupada" si aún no hay items.
            // La mesa cambia automáticamente según el conteo real de productos.
            await syncMesaEstadoByItems(connection, mesa_id);
            const conf = await getEnvioCocinaConfig(connection);

            await connection.commit();
            connection.release();
            res.status(201).json({
                pedido: {
                    id: insert.insertId,
                    mesa_id,
                    cliente_id: cliente_id || null,
                    mesero_nombre: meseroNombre,
                    estado: 'abierto',
                    total: 0,
                    notas: notas || null
                },
                auto_listo_comanda: !!conf.auto_listo_comanda,
                imprime_servidor: !!conf.imprime_servidor
            });
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

// GET /mesas/pedidos/:pedidoId/comanda - Vista de comanda para impresión rápida
// Query params opcionales:
// - item_ids=1,2,3 -> imprime solo esos items
// - auto_print=1 -> dispara window.print al cargar
// Relacionado con:
// - public/js/mesas.js (enviar a cocina)
router.get('/pedidos/:pedidoId/comanda', async (req, res) => {
    try {
        const pedidoId = Number(req.params.pedidoId);
        if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
            return res.status(400).send('Pedido inválido');
        }

        const [cfgRows] = await db.query('SELECT * FROM configuracion_impresion LIMIT 1');
        const config = cfgRows?.[0] || { nombre_negocio: 'Comanda', direccion: '', telefono: '', ancho_papel: 80, font_size: 1 };

        const [pedidos] = await db.query(
            `SELECT p.*, m.numero AS mesa_numero
             FROM pedidos p
             JOIN mesas m ON m.id = p.mesa_id
             WHERE p.id = ?
             LIMIT 1`,
            [pedidoId]
        );
        if (!pedidos.length) return res.status(404).send('Pedido no encontrado');
        const pedido = pedidos[0];

        const rawIds = String(req.query.item_ids || '').trim();
        const ids = rawIds
            ? rawIds.split(',').map(x => Number(String(x || '').trim())).filter(n => Number.isInteger(n) && n > 0)
            : [];

        const incluirImpresos = String(req.query.incluir_impresos || '') === '1';
        const marcarImpresos = String(req.query.marcar_impresos || '1') === '1';

        let sql = `
            SELECT i.*, pr.nombre AS producto_nombre
            FROM pedido_items i
            JOIN productos pr ON pr.id = i.producto_id
            WHERE i.pedido_id = ?
              AND i.estado IN ('enviado','preparando','listo')
              ${incluirImpresos ? '' : 'AND i.comanda_impresa_at IS NULL'}
        `;
        const params = [pedidoId];
        if (ids.length > 0) {
            sql += ' AND i.id IN (?)';
            params.push(ids);
        }
        sql += ' ORDER BY i.created_at ASC, i.id ASC';

        const connection = await db.getConnection();
        let items = [];
        try {
            await connection.beginTransaction();
            const [rows] = await connection.query(sql, params);
            items = rows || [];

            // Marcamos como impresos los items incluidos en la comanda.
            // Evita duplicación en próximas impresiones de la misma mesa.
            if (marcarImpresos && items.length > 0) {
                const idsImpresos = items.map((it) => Number(it.id)).filter((n) => Number.isInteger(n) && n > 0);
                if (idsImpresos.length > 0) {
                    await connection.query(
                        `UPDATE pedido_items
                         SET comanda_impresa_at = COALESCE(comanda_impresa_at, NOW())
                         WHERE id IN (?)`,
                        [idsImpresos]
                    );
                }
            }

            await connection.commit();
            connection.release();
        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }

        res.render('comanda', {
            pedido,
            items: items || [],
            config,
            auto_print: String(req.query.auto_print || '') === '1'
        });
    } catch (error) {
        console.error('Error al generar comanda:', error);
        res.status(500).send('Error al generar comanda');
    }
});

// POST /mesas/pedidos/:pedidoId/comanda/imprimir-servidor
// Imprime comanda desde la PC/servidor para evitar dependencia de AirPrint en celulares.
router.post('/pedidos/:pedidoId/comanda/imprimir-servidor', async (req, res) => {
    try {
        const pedidoId = Number(req.params.pedidoId);
        if (!Number.isInteger(pedidoId) || pedidoId <= 0) {
            return res.status(400).json({ error: 'Pedido inválido' });
        }

        const raw = Array.isArray(req.body?.item_ids) ? req.body.item_ids : [];
        const ids = raw
            .map((x) => Number(x))
            .filter((n) => Number.isInteger(n) && n > 0);
        if (ids.length === 0) {
            return res.status(400).json({ error: 'item_ids requerido' });
        }

        const [cfgRows] = await db.query('SELECT * FROM configuracion_impresion LIMIT 1');
        const cfg         = cfgRows?.[0] || {};
        const printerName = String(cfg?.impresora_comandas || '').trim() || null;
        // Parámetros de papel — necesarios para System.Drawing.Printing (tamaño del rollo térmico)
        const anchoPapel  = Number(cfg?.ancho_papel || 80);
        const fontSize    = Number(cfg?.font_size   || 1);

        const [pedidos] = await db.query(
            `SELECT p.*, m.numero AS mesa_numero
             FROM pedidos p
             JOIN mesas m ON m.id = p.mesa_id
             WHERE p.id = ?
             LIMIT 1`,
            [pedidoId]
        );
        if (!pedidos.length) return res.status(404).json({ error: 'Pedido no encontrado' });
        const pedido = pedidos[0];

        const [items] = await db.query(
            `SELECT i.*, pr.nombre AS producto_nombre
             FROM pedido_items i
             JOIN productos pr ON pr.id = i.producto_id
             WHERE i.pedido_id = ?
               AND i.id IN (?)
               AND i.comanda_impresa_at IS NULL
             ORDER BY i.created_at ASC, i.id ASC`,
            [pedidoId, ids]
        );
        if (!items.length) {
            return res.status(200).json({ printed: false, message: 'No hay items nuevos para imprimir' });
        }

        const texto = buildComandaTexto({
            pedido,
            items,
            negocio: cfg?.nombre_negocio || 'COMANDA'
        });
        await imprimirTextoEnServidor(texto, printerName, anchoPapel, fontSize);

        const idsImpresos = items.map((it) => Number(it.id)).filter((n) => Number.isInteger(n) && n > 0);
        await db.query(
            `UPDATE pedido_items
             SET comanda_impresa_at = COALESCE(comanda_impresa_at, NOW())
             WHERE id IN (?)`,
            [idsImpresos]
        );

        return res.json({
            printed: true,
            impresora: printerName || 'predeterminada',
            total_items: idsImpresos.length
        });
    } catch (error) {
        console.error('Error al imprimir comanda en servidor:', error);
        return res.status(500).json({ error: 'No se pudo imprimir la comanda en servidor' });
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
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            const [result] = await connection.query(
                `INSERT INTO pedido_items (pedido_id, producto_id, cantidad, unidad_medida, precio_unitario, subtotal, estado, nota)
                 VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?)` ,
                [pedidoId, producto_id, cantidad, unidad || 'UND', precio, subtotal, nota || null]
            );
            const [pedidoRows] = await connection.query('SELECT mesa_id FROM pedidos WHERE id = ? LIMIT 1', [pedidoId]);
            if (pedidoRows.length > 0) {
                await syncMesaEstadoByItems(connection, pedidoRows[0].mesa_id);
            }
            await connection.commit();
            connection.release();
            res.status(201).json({ id: result.insertId });
        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (error) {
        console.error('Error al agregar item:', error);
        res.status(500).json({ error: 'Error al agregar item' });
    }
});

// PUT /mesas/items/:itemId - API: editar item del pedido (solo pendiente y antes de enviar)
// Relacionado con:
// - public/js/mesas.js (botón "Editar" en cada item pendiente)
// - requerimiento funcional: poder editar antes de enviar a cocina
router.put('/items/:itemId', async (req, res) => {
    try {
        const itemId = req.params.itemId;
        const { cantidad, nota } = req.body || {};
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            const [rows] = await connection.query(
                `SELECT i.id, i.estado, i.cantidad, i.precio_unitario, i.nota
                 FROM pedido_items i
                 WHERE i.id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [itemId]
            );
            if (!rows.length) {
                throw new Error('Item no encontrado');
            }
            const actual = rows[0];
            if (String(actual.estado || '').toLowerCase() !== 'pendiente') {
                throw new Error('Solo se pueden editar items pendientes (antes de enviar a cocina)');
            }

            const nuevaCantidad = (cantidad != null && cantidad !== '') ? Number(cantidad) : Number(actual.cantidad || 0);
            if (!Number.isFinite(nuevaCantidad) || nuevaCantidad <= 0) {
                throw new Error('La cantidad debe ser mayor a 0');
            }
            const nuevaNota = (nota != null) ? String(nota).trim() : String(actual.nota || '').trim();
            const precio = Number(actual.precio_unitario || 0);
            const subtotal = nuevaCantidad * precio;

            await connection.query(
                `UPDATE pedido_items
                 SET cantidad = ?, subtotal = ?, nota = ?
                 WHERE id = ? AND estado = 'pendiente'`,
                [nuevaCantidad, subtotal, nuevaNota || null, itemId]
            );

            const mesaId = await getMesaIdByItem(connection, itemId);
            if (mesaId) {
                await syncMesaEstadoByItems(connection, mesaId);
            }

            await connection.commit();
            connection.release();
            res.json({ message: 'Item actualizado' });
        } catch (err) {
            await connection.rollback();
            connection.release();
            const msg = String(err?.message || 'Error al editar item');
            if (msg.includes('no encontrado')) {
                return res.status(404).json({ error: msg });
            }
            if (msg.includes('pendientes') || msg.includes('cantidad')) {
                return res.status(400).json({ error: msg });
            }
            throw err;
        }
    } catch (error) {
        console.error('Error al editar item:', error);
        res.status(500).json({ error: 'Error al editar item' });
    }
});

// DELETE /mesas/items/:itemId - API: eliminar item del pedido
// Relacionado con: public/js/mesas.js (función eliminarItem)
// IMPORTANTE: solo permite eliminar items en estado "pendiente"
router.delete('/items/:itemId', async (req, res) => {
    try {
        const itemId = req.params.itemId;
        console.log(`DELETE /api/mesas/items/${itemId} - Eliminando item`);
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            const [itemRows] = await connection.query(
                `SELECT i.id, i.estado, p.mesa_id
                 FROM pedido_items i
                 JOIN pedidos p ON p.id = i.pedido_id
                 WHERE i.id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [itemId]
            );
            if (!itemRows.length) {
                console.log(`Item ${itemId} no encontrado`);
                await connection.rollback();
                connection.release();
                return res.status(404).json({ error: 'Item no encontrado' });
            }
            if (String(itemRows[0].estado || '').toLowerCase() !== 'pendiente') {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ error: 'Solo se pueden eliminar items pendientes (antes de enviar)' });
            }

            const [result] = await connection.query(
                `DELETE FROM pedido_items WHERE id = ? AND estado = 'pendiente'`,
                [itemId]
            );
            if ((result?.affectedRows || 0) === 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ error: 'No se pudo eliminar el item' });
            }

            await syncMesaEstadoByItems(connection, itemRows[0].mesa_id);
            await connection.commit();
            connection.release();
            console.log(`Item ${itemId} eliminado exitosamente`);
            res.json({ message: 'Item eliminado' });
        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (error) {
        console.error('Error al eliminar item:', error);
        res.status(500).json({ error: 'Error al eliminar item' });
    }
});

// PUT /mesas/items/:itemId/enviar - API: enviar item a cocina
router.put('/items/:itemId/enviar', async (req, res) => {
    try {
        const itemId = req.params.itemId;
        const meseroNombre = String(req.session?.user?.nombre || req.session?.user?.usuario || '').trim() || null;
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            const [itemRows] = await connection.query(
                `SELECT i.id, i.pedido_id, i.estado
                 FROM pedido_items i
                 WHERE i.id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [itemId]
            );
            if (!itemRows.length) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ error: 'Item no encontrado' });
            }
            if (String(itemRows[0].estado || '').toLowerCase() !== 'pendiente') {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ error: 'Solo se pueden enviar items pendientes' });
            }

            const pedidoId = Number(itemRows[0].pedido_id);
            const conf = await getEnvioCocinaConfig(connection);
            const autoListoComanda = !!conf.auto_listo_comanda;
            const targetEstado = autoListoComanda ? 'listo' : 'enviado';
            await connection.query(
                `UPDATE pedido_items
                 SET estado = ?, enviado_at = NOW(), listo_at = CASE WHEN ? = 'listo' THEN NOW() ELSE listo_at END
                 WHERE id = ?`,
                [targetEstado, targetEstado, itemId]
            );

            // Si el pedido no tenía responsable, lo tomamos del usuario actual que envía.
            if (meseroNombre) {
                await connection.query(
                    `UPDATE pedidos
                     SET mesero_nombre = COALESCE(NULLIF(mesero_nombre, ''), ?)
                     WHERE id = ?`,
                    [meseroNombre, pedidoId]
                );
            }

            await connection.commit();
            connection.release();
            res.json({
                message: autoListoComanda ? 'Item enviado e iniciado como listo' : 'Item enviado a cocina',
                estado: targetEstado,
                auto_listo_comanda: autoListoComanda
            });
        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (error) {
        console.error('Error al enviar item:', error);
        res.status(500).json({ error: 'Error al enviar item' });
    }
});

// PUT /mesas/items/:itemId/cancelar - API: cancelar item desde Mesa (mesero/admin)
// Reglas:
// - Permite cancelar items en estados operativos: pendiente, enviado, preparando, listo
// - Se marca como "rechazado" para que sea visible en Cocina (tab Rechazados)
// Relacionado con:
// - public/js/mesas.js (botón Cancelar en la mesa)
// - routes/cocina.js (GET /api/cocina/rechazados)
router.put('/items/:itemId/cancelar', async (req, res) => {
    try {
        const itemId = req.params.itemId;
        const rol = String(req.session?.user?.rol || '').toLowerCase();
        if (!['mesero', 'administrador'].includes(rol)) {
            return res.status(403).json({ error: 'No autorizado para cancelar items desde mesa' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();
            const [result] = await connection.query(
                `UPDATE pedido_items
                 SET estado = 'rechazado'
                 WHERE id = ?
                   AND estado IN ('pendiente','enviado','preparando','listo')`,
                [itemId]
            );
            if ((result?.affectedRows || 0) === 0) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({ error: 'No se pudo cancelar: estado no permitido o item no encontrado' });
            }

            const mesaId = await getMesaIdByItem(connection, itemId);
            if (mesaId) await syncMesaEstadoByItems(connection, mesaId);

            await connection.commit();
            connection.release();
            res.json({ message: 'Item cancelado' });
        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (error) {
        console.error('Error al cancelar item desde mesa:', error);
        res.status(500).json({ error: 'Error al cancelar item' });
    }
});

// DELETE /mesas/pedidos/:pedidoId/items/rechazados - limpiar items rechazados/cancelados de un pedido
// Reglas:
// - Solo mesero/admin puede ejecutar limpieza desde la mesa
// - Borra items en estado final no facturable: rechazado/cancelado
// - Si el pedido queda sin items, lo marca como cancelado para que la mesa quede limpia
// Relacionado con:
// - public/js/mesas.js (botón "Limpiar rechazados")
// - views/mesas.ejs (controles del offcanvas)
router.delete('/pedidos/:pedidoId/items/rechazados', async (req, res) => {
    try {
        const pedidoId = req.params.pedidoId;
        const rol = String(req.session?.user?.rol || '').toLowerCase();
        if (!['mesero', 'administrador'].includes(rol)) {
            return res.status(403).json({ error: 'No autorizado para limpiar items rechazados' });
        }

        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            const [pedRows] = await connection.query(
                `SELECT id, mesa_id, estado
                 FROM pedidos
                 WHERE id = ?
                 LIMIT 1
                 FOR UPDATE`,
                [pedidoId]
            );
            if (!pedRows.length) {
                await connection.rollback();
                connection.release();
                return res.status(404).json({ error: 'Pedido no encontrado' });
            }
            const pedido = pedRows[0];

            const [result] = await connection.query(
                `DELETE FROM pedido_items
                 WHERE pedido_id = ?
                   AND estado IN ('rechazado','cancelado')`,
                [pedidoId]
            );

            const [restantes] = await connection.query(
                `SELECT COUNT(*) AS cnt
                 FROM pedido_items
                 WHERE pedido_id = ?`,
                [pedidoId]
            );
            const quedanItems = Number(restantes?.[0]?.cnt || 0);

            if (quedanItems === 0 && !['cerrado', 'cancelado', 'rechazado'].includes(String(pedido.estado || '').toLowerCase())) {
                await connection.query(
                    `UPDATE pedidos
                     SET estado = 'cancelado', total = 0
                     WHERE id = ?`,
                    [pedidoId]
                );
            }

            await syncMesaEstadoByItems(connection, pedido.mesa_id);
            await connection.commit();
            connection.release();

            res.json({
                message: 'Items rechazados limpiados',
                eliminados: Number(result?.affectedRows || 0),
                pedido_cancelado: quedanItems === 0
            });
        } catch (err) {
            await connection.rollback();
            connection.release();
            throw err;
        }
    } catch (error) {
        console.error('Error al limpiar items rechazados:', error);
        res.status(500).json({ error: 'Error al limpiar items rechazados' });
    }
});

// PUT /mesas/items/:itemId/estado - API: actualizar estado de item (preparando, listo, servido, cancelado)
router.put('/items/:itemId/estado', async (req, res) => {
    try {
        const itemId = req.params.itemId;
        const { estado } = req.body || {};
        // 'rechazado' se usa para visualizar cancelaciones en Cocina.
        // Relacionado con: routes/cocina.js (/api/cocina/rechazados)
        const permitidos = ['pendiente','enviado','preparando','listo','servido','cancelado','rechazado'];
        if (!permitidos.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

        // Restricción por rol:
        // - Mesero: SOLO puede marcar "servido" y SOLO si el item está en estado "listo"
        // Relacionado con: vista Cocina (pestaña Listos) y requisito del usuario
        const rol = String(req.session?.user?.rol || '').toLowerCase();
        if (rol === 'mesero') {
            if (estado !== 'servido') {
                return res.status(403).json({ error: 'No autorizado: el mesero solo puede marcar como entregado' });
            }
            const [resultServido] = await db.query(
                `UPDATE pedido_items SET estado = 'servido', servido_at = NOW() WHERE id = ? AND estado = 'listo'`,
                [itemId]
            );
            if ((resultServido?.affectedRows || 0) === 0) {
                return res.status(400).json({ error: 'Solo se puede marcar como entregado cuando el pedido está listo' });
            }
            const connection = await db.getConnection();
            try {
                const mesaId = await getMesaIdByItem(connection, itemId);
                if (mesaId) await syncMesaEstadoByItems(connection, mesaId);
            } finally {
                connection.release();
            }
            return res.json({ message: 'Estado actualizado' });
        }

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

        const connection = await db.getConnection();
        try {
            const mesaId = await getMesaIdByItem(connection, itemId);
            if (mesaId) await syncMesaEstadoByItems(connection, mesaId);
        } finally {
            connection.release();
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
    const { cliente_id, forma_pago, pagos } = req.body || {};
    if (!cliente_id) return res.status(400).json({ error: 'cliente_id requerido para facturar' });
    // forma_pago se mantiene por compatibilidad, pero lo recomendado es enviar pagos[] (pago mixto)
    try {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            const [pedidos] = await connection.query('SELECT * FROM pedidos WHERE id = ? FOR UPDATE', [pedidoId]);
            if (pedidos.length === 0) throw new Error('Pedido no encontrado');
            const pedido = pedidos[0];

            const [items] = await connection.query(
                // Excluir items cancelados o rechazados de la factura
                // Relacionado con: estado "rechazado" (database.sql)
                `SELECT * FROM pedido_items WHERE pedido_id = ? AND estado NOT IN ('cancelado','rechazado')`,
                [pedidoId]
            );
            if (items.length === 0) throw new Error('Pedido sin items');

            const total = items.reduce((acc, it) => acc + Number(it.subtotal || 0), 0);

            // ===== Pago mixto: validar pagos[] si se envía =====
            // Relacionado con: public/js/mesas.js (modal de pagos)
            const normalizarPagos = (arr) => {
                if (!Array.isArray(arr)) return [];
                return arr
                    .filter(p => p && typeof p === 'object')
                    .map(p => ({
                        metodo: String(p.metodo || '').toLowerCase().trim(),
                        monto: Number(p.monto || 0),
                        referencia: (p.referencia != null && String(p.referencia).trim() !== '') ? String(p.referencia).trim() : null
                    }))
                    .filter(p => ['efectivo', 'transferencia', 'tarjeta'].includes(p.metodo) && Number.isFinite(p.monto) && p.monto > 0);
            };
            const pagosNorm = normalizarPagos(pagos);
            const sumaPagos = pagosNorm.reduce((acc, p) => acc + Number(p.monto || 0), 0);
            const almostEqualMoney = (a, b) => Math.abs(Number(a) - Number(b)) < 0.01;

            let formaPagoDB = String(forma_pago || 'efectivo').toLowerCase();
            if (pagosNorm.length > 0) {
                if (!almostEqualMoney(sumaPagos, total)) {
                    throw new Error('La suma de pagos no coincide con el total');
                }
                formaPagoDB = (pagosNorm.length === 1) ? pagosNorm[0].metodo : 'mixto';
            } else {
                // Compatibilidad: si no envían pagos, usamos forma_pago (y creamos 1 registro en factura_pagos)
                if (!['efectivo', 'transferencia', 'tarjeta', 'mixto'].includes(formaPagoDB)) formaPagoDB = 'efectivo';
            }

            const [facturaInsert] = await connection.query(
                `INSERT INTO facturas (cliente_id, total, forma_pago) VALUES (?, ?, ?)`,
                [cliente_id, total, formaPagoDB]
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

            // Guardar pagos en factura_pagos (si existe la tabla)
            try {
                if (pagosNorm.length > 0) {
                    const pagosValues = pagosNorm.map(p => ([facturaId, p.metodo, p.monto, p.referencia]));
                    await connection.query(
                        'INSERT INTO factura_pagos (factura_id, metodo, monto, referencia) VALUES ?',
                        [pagosValues]
                    );
                } else {
                    await connection.query(
                        'INSERT INTO factura_pagos (factura_id, metodo, monto, referencia) VALUES (?, ?, ?, ?)',
                        [facturaId, (formaPagoDB === 'mixto' ? 'efectivo' : formaPagoDB), total, null]
                    );
                }
            } catch (_) {
                // Si la tabla no existe, no rompemos la facturación
            }

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

            // Validar que el destino esté libre: sin items activos en pedidos abiertos
            const [abiertosDestino] = await connection.query(
                `SELECT COUNT(*) as cnt
                 FROM pedido_items i
                 JOIN pedidos p ON p.id = i.pedido_id
                 WHERE p.mesa_id = ?
                   AND p.estado NOT IN ('cerrado','cancelado','rechazado')
                   AND i.estado NOT IN ('cancelado','rechazado')`,
                [mesa_destino_id]
            );
            if ((abiertosDestino[0]?.cnt || 0) > 0) {
                throw new Error('La mesa destino tiene un pedido activo');
            }

            // Actualizar estados de mesas (origen puede quedar ocupada si tuviera otros pedidos, pero por defecto quedará libre)
            await connection.query('UPDATE pedidos SET mesa_id = ? WHERE id = ?', [mesa_destino_id, pedidoId]);

            // Poner libre la mesa origen si no le quedan items activos
            const [restantesOrigen] = await connection.query(
                `SELECT COUNT(*) as cnt
                 FROM pedido_items i
                 JOIN pedidos p ON p.id = i.pedido_id
                 WHERE p.mesa_id = ?
                   AND p.estado NOT IN ('cerrado','cancelado','rechazado')
                   AND i.estado NOT IN ('cancelado','rechazado')`,
                [pedido.mesa_id]
            );
            if ((restantesOrigen[0]?.cnt || 0) === 0) {
                await connection.query('UPDATE mesas SET estado = "libre" WHERE id = ?', [pedido.mesa_id]);
            }

            // Recalcular estado de ambas mesas según items activos reales.
            await syncMesaEstadoByItems(connection, pedido.mesa_id);
            await syncMesaEstadoByItems(connection, mesa_destino_id);

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
                // 'rechazado' se considera finalizado (no pedido activo)
                // Relacionado con: estado "rechazado" (database.sql)
                `SELECT p.id FROM pedidos p WHERE p.mesa_id = ? AND p.estado NOT IN ('cerrado','cancelado','rechazado') FOR UPDATE`,
                [mesaId]
            );

            if (abiertos.length > 0) {
                // Verificar que no tengan items distintos de cancelado
                const ids = abiertos.map(p => p.id);
                const [items] = await connection.query(
                    // Consideramos "rechazado" igual que "cancelado" (no es item activo)
                    // Relacionado con: estado "rechazado" (database.sql)
                    `SELECT COUNT(*) as cnt FROM pedido_items WHERE pedido_id IN (?) AND estado NOT IN ('cancelado','rechazado')`,
                    [ids]
                );
                if ((items[0]?.cnt || 0) > 0) {
                    throw new Error('La mesa tiene items activos, no se puede liberar');
                }
                // Si no hay items activos, marcamos esos pedidos como RECHAZADOS (nuevo estado)
                // y actualizamos items cancelados a rechazados para poder visualizarlos en Cocina.
                // Relacionado con:
                // - routes/cocina.js (GET /api/cocina/rechazados)
                // - views/cocina.ejs (pestaña Rechazados)
                await connection.query(
                    `UPDATE pedido_items SET estado = 'rechazado' WHERE pedido_id IN (?) AND estado = 'cancelado'`,
                    [ids]
                );
                await connection.query(`UPDATE pedidos SET estado = 'rechazado' WHERE id IN (?)`, [ids]);
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


