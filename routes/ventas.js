const express = require('express');
const router = express.Router();
const db = require('../db');

/**
 * Construye cláusula WHERE y params para filtros de ventas.
 * Relacionado con:
 * - views/ventas.ejs (filtros por fecha y búsqueda)
 * - routes/ventas.js (listado y export)
 */
function buildVentasWhere(queryParams) {
    const where = [];
    const params = [];

    if (queryParams.desde && queryParams.hasta) {
        where.push('DATE(f.fecha) BETWEEN ? AND ?');
        params.push(queryParams.desde, queryParams.hasta);
    }

    if (queryParams.q) {
        where.push('(c.nombre LIKE ? OR f.id LIKE ?)');
        const term = `%${queryParams.q}%`;
        params.push(term, term);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    return { whereSql, params };
}

/**
 * Calcula totales por método usando factura_pagos (incluye facturas mixtas).
 * Si una factura no tiene registros en factura_pagos (legacy), cae a f.forma_pago + f.total.
 */
async function getTotalesPorMetodo(queryParams) {
    const { whereSql, params } = buildVentasWhere(queryParams);

    // Para el segundo SELECT (fallback) necesitamos agregar condición fp2.id IS NULL
    const whereSqlFallback = whereSql
        ? `${whereSql} AND fp2.id IS NULL`
        : 'WHERE fp2.id IS NULL';

    // params se usa dos veces (UNION)
    const unionParams = [...params, ...params];

    // Solo totalizamos los métodos reales (no "mixto")
    const sql = `
        SELECT metodo, SUM(monto) AS total
        FROM (
            -- Facturas con pagos detallados
            SELECT fp.metodo AS metodo, fp.monto AS monto
            FROM factura_pagos fp
            JOIN facturas f ON f.id = fp.factura_id
            JOIN clientes c ON f.cliente_id = c.id
            ${whereSql}

            UNION ALL

            -- Fallback legacy: facturas sin registros en factura_pagos
            SELECT f.forma_pago AS metodo, f.total AS monto
            FROM facturas f
            JOIN clientes c ON f.cliente_id = c.id
            LEFT JOIN factura_pagos fp2 ON fp2.factura_id = f.id
            ${whereSqlFallback}
        ) t
        WHERE t.metodo IN ('efectivo','transferencia','tarjeta')
        GROUP BY t.metodo
    `;

    const totales = { efectivo: 0, transferencia: 0, tarjeta: 0, general: 0 };

    try {
        const [rows] = await db.query(sql, unionParams);
        (rows || []).forEach(r => {
            const metodo = String(r.metodo || '').toLowerCase();
            const val = Number(r.total || 0);
            if (metodo === 'efectivo') totales.efectivo = val;
            if (metodo === 'transferencia') totales.transferencia = val;
            if (metodo === 'tarjeta') totales.tarjeta = val;
        });
    } catch (err) {
        // Si no existe factura_pagos (instalación vieja), no rompemos: fallback a forma_pago
        try {
            const sqlOld = `
                SELECT f.forma_pago AS metodo, SUM(f.total) AS total
                FROM facturas f
                JOIN clientes c ON f.cliente_id = c.id
                ${whereSql}
                GROUP BY f.forma_pago
            `;
            const [rowsOld] = await db.query(sqlOld, params);
            (rowsOld || []).forEach(r => {
                const metodo = String(r.metodo || '').toLowerCase();
                const val = Number(r.total || 0);
                if (metodo === 'efectivo') totales.efectivo = val;
                if (metodo === 'transferencia') totales.transferencia = val;
                if (metodo === 'tarjeta') totales.tarjeta = val;
            });
        } catch (_) {
            // si todo falla, dejamos en 0
        }
        console.error('Error calculando totales por método:', err);
    }

    totales.general = Number(totales.efectivo) + Number(totales.transferencia) + Number(totales.tarjeta);
    return totales;
}

// Ruta principal de ventas con filtros opcionales por fecha
router.get('/', async (req, res) => {
    try {
        const { whereSql, params } = buildVentasWhere(req.query);
        const query = `
            SELECT f.*, c.nombre as cliente_nombre
            FROM facturas f
            JOIN clientes c ON f.cliente_id = c.id
            ${whereSql}
            ORDER BY f.fecha DESC
        `;

        const [ventas] = await db.query(query, params);
        const totales = await getTotalesPorMetodo(req.query);
        res.render('ventas', { ventas, totales });
    } catch (error) {
        console.error('Error al obtener ventas:', error);
        res.status(500).send('Error al cargar el historial de ventas');
    }
});

// GET /ventas/export - Exportar CSV por rango y búsqueda
router.get('/export', async (req, res) => {
    try {
        // Lazy import para no romper el arranque si falta la dependencia
        let ExcelJS;
        try {
            ExcelJS = require('exceljs');
        } catch (e) {
            return res.status(500).send('Exportación a Excel no disponible. Instale la dependencia con: npm install exceljs');
        }
        const { whereSql, params } = buildVentasWhere(req.query);
        const query = `
            SELECT f.id, f.fecha, c.nombre as cliente, f.forma_pago, f.total
            FROM facturas f
            JOIN clientes c ON f.cliente_id = c.id
            ${whereSql}
        `;
        const queryFinal = `${query} ORDER BY f.fecha DESC`;

        const [rows] = await db.query(queryFinal, params);
        const totales = await getTotalesPorMetodo(req.query);

        // Crear Excel con ExcelJS
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Ventas');

        // Traer configuración para encabezado (nombre, logo, etc.)
        let config = null;
        try {
            const [cfg] = await db.query('SELECT * FROM configuracion_impresion LIMIT 1');
            config = (cfg && cfg[0]) ? cfg[0] : null;
        } catch (_) {}

        // Encabezado superior elegante
        const titulo = (config?.nombre_negocio || 'Reporte de Ventas');
        const subInfo = [
            config?.direccion ? config.direccion : null,
            config?.telefono ? `Tel: ${config.telefono}` : null,
            config?.nit ? `NIT: ${config.nit}` : null
        ].filter(Boolean).join('  •  ');
        const rango = `Rango: ${req.query.desde || '-'} a ${req.query.hasta || '-'}${req.query.q ? '  •  Filtro: ' + req.query.q : ''}`;

        // Mover título a partir de la columna B para dejar el logo en A
        ws.mergeCells('B1:E1');
        ws.mergeCells('B2:E2');
        ws.mergeCells('B3:E3');
        ws.getRow(1).values = ['', titulo];
        ws.getRow(2).values = ['', subInfo];
        ws.getRow(3).values = ['', rango];
        ws.getRow(1).font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
        ws.getRow(1).alignment = { horizontal: 'center', vertical: 'middle' };
        ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D6EFD' } }; // azul bootstrap
        ws.getRow(2).font = { color: { argb: 'FF0D6EFD' } };
        ws.getRow(2).alignment = { horizontal: 'center' };
        ws.getRow(3).font = { italic: true, color: { argb: 'FF495057' } };
        ws.getRow(3).alignment = { horizontal: 'center' };
        ws.getRow(1).height = 24; ws.getRow(2).height = 18; ws.getRow(3).height = 18;
        ws.addRow([]); // fila 4 separadora

        // Logo si existe
        if (config?.logo_data) {
            try {
                const ext = (config.logo_tipo || '').includes('png') ? 'png' : 'jpeg';
                const imgId = wb.addImage({ buffer: Buffer.from(config.logo_data), extension: ext });
                ws.addImage(imgId, { tl: { col: 0, row: 0 }, ext: { width: 100, height: 60 } });
            } catch (_) {}
        }

        // Crear encabezado de columnas manual (fila siguiente disponible)
        const headerRow = ws.addRow(['Factura #','Fecha','Cliente','Forma de Pago','Total']);
        headerRow.font = { bold: true, color: { argb: 'FF212529' } };
        headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
        headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9ECEF' } };
        headerRow.border = { bottom: { style: 'thin', color: { argb: 'FFADB5BD' } } };
        // Anchos de columnas
        ws.getColumn(1).width = 12;
        ws.getColumn(2).width = 22;
        ws.getColumn(3).width = 32;
        ws.getColumn(4).width = 18;
        ws.getColumn(5).width = 14;

        // Datos y totales
        let totalEfectivo = 0, totalTransferencia = 0, totalTarjeta = 0, totalGeneral = 0;
        rows.forEach(r => {
            const fecha = new Date(r.fecha);
            const total = Number(r.total || 0);
            totalGeneral += total;
            // Para Excel: mantenemos el cálculo general por facturas, pero los totales por método vienen de factura_pagos
            ws.addRow([
                r.id,
                fecha.toLocaleString(),
                r.cliente || '',
                (r.forma_pago || '').charAt(0).toUpperCase() + (r.forma_pago || '').slice(1),
                total
            ]);
        });

        // Totales por método (desde pagos)
        totalEfectivo = Number(totales.efectivo || 0);
        totalTransferencia = Number(totales.transferencia || 0);
        totalTarjeta = Number(totales.tarjeta || 0);
        // totalGeneral del footer: suma por método para consistencia con pago mixto
        totalGeneral = Number(totales.general || (totalEfectivo + totalTransferencia + totalTarjeta));

        // Zebra striping para legibilidad
        const firstDataRow = headerRow.number + 1;
        for (let r = firstDataRow; r <= ws.rowCount; r++) {
            if ((r - firstDataRow) % 2 === 0) {
                ws.getRow(r).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FA' } };
            }
        }
        ws.getColumn(2).alignment = { horizontal: 'left' };
        ws.getColumn(5).alignment = { horizontal: 'right' };
        ws.getColumn(5).numFmt = '[$$-409]#,##0.00';

        // Totales
        const start = ws.rowCount + 2;
        ws.addRow([]);
        ws.addRow(['', '', 'Total Efectivo:', '', totalEfectivo]).font = { bold: true };
        ws.addRow(['', '', 'Total Transferencia:', '', totalTransferencia]).font = { bold: true };
        ws.addRow(['', '', 'Total Tarjeta:', '', totalTarjeta]).font = { bold: true };
        ws.addRow(['', '', 'Total General:', '', totalGeneral]).font = { bold: true };
        for (let i = start; i <= ws.rowCount; i++) {
            ws.getRow(i).getCell(5).numFmt = '[$$-409]#,##0.00';
            ws.getRow(i).getCell(3).alignment = { horizontal: 'right' };
        }

        // Congelar hasta la fila del encabezado
        ws.views = [{ state: 'frozen', ySplit: headerRow.number }];

        // Auto-ajustar ancho de columnas (mín 10, máx 40)
        const minW = 10, maxW = 40;
        ws.columns.forEach((col, idx) => {
            let max = 0;
            col.eachCell({ includeEmpty: false }, cell => {
                const v = cell.value;
                const len = (v && v.toString) ? v.toString().length : 0;
                if (len > max) max = len;
            });
            col.width = Math.max(minW, Math.min(maxW, max + 2));
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="ventas.xlsx"');
        await wb.xlsx.write(res);
        res.end();
    } catch (error) {
        console.error('Error al exportar ventas:', error);
        res.status(500).send('Error al exportar');
    }
});

module.exports = router; 