const LB_TO_KG = 0.453592;
const UNIDADES = ['KG', 'UND', 'LB'];
const ESTADOS_CON_STOCK = ['enviado', 'preparando', 'listo', 'servido'];

class StockError extends Error {
    constructor(message, extra = {}) {
        super(message);
        this.name = 'StockError';
        this.status = extra.status || 409;
        this.producto = extra.producto || null;
        this.disponible = extra.disponible;
        this.unidad = extra.unidad || null;
    }
}

function round2(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return NaN;
    return Math.round((n + Number.EPSILON) * 100) / 100;
}

function unidadValida(unidad) {
    const u = String(unidad || '').toUpperCase();
    return UNIDADES.includes(u) ? u : null;
}

function convertirAUnidadStock(cantidad, unidadItem, unidadStock) {
    const from = unidadValida(unidadItem);
    const to = unidadValida(unidadStock);
    const qty = round2(cantidad);
    if (!from || !to) {
        throw new StockError('Unidad de stock inválida', { status: 400 });
    }
    if (!Number.isFinite(qty) || qty <= 0) {
        throw new StockError('La cantidad debe ser mayor a 0', { status: 400 });
    }
    if (from === to) return qty;
    const peso = from === 'KG' || from === 'LB';
    const pesoStock = to === 'KG' || to === 'LB';
    if (!peso || !pesoStock) {
        throw new StockError(
            `La unidad del pedido (${from}) no coincide con la unidad de stock (${to})`,
            { status: 409 }
        );
    }
    if (from === 'LB' && to === 'KG') return round2(qty * LB_TO_KG);
    return round2(qty / LB_TO_KG);
}

async function movimientoExiste(connection, pedidoItemId, tipo) {
    const [rows] = await connection.query(
        `SELECT id, cantidad
         FROM stock_movimientos
         WHERE pedido_item_id = ? AND tipo = ?
         LIMIT 1`,
        [pedidoItemId, tipo]
    );
    return rows[0] || null;
}

async function bloquearProducto(connection, productoId) {
    const [rows] = await connection.query(
        `SELECT id, nombre, controla_stock, stock_actual, stock_minimo, unidad_stock
         FROM productos
         WHERE id = ?
         LIMIT 1
         FOR UPDATE`,
        [productoId]
    );
    if (!rows.length) {
        throw new StockError('Producto no encontrado', { status: 404 });
    }
    return rows[0];
}

async function registrar(connection, { producto, tipo, delta, pedidoItemId, motivo, usuarioId }) {
    const anterior = round2(producto.stock_actual);
    const nuevo = round2(anterior + delta);
    if (nuevo < -0.001) {
        const necesario = round2(Math.abs(delta));
        throw new StockError(
            `No hay stock de ${producto.nombre}. Disponible: ${anterior} ${producto.unidad_stock}. Se necesitan ${necesario} ${producto.unidad_stock}.`,
            {
                status: 409,
                producto: producto.nombre,
                disponible: anterior,
                unidad: producto.unidad_stock
            }
        );
    }
    await connection.query(
        `UPDATE productos SET stock_actual = ? WHERE id = ?`,
        [nuevo, producto.id]
    );
    await connection.query(
        `INSERT INTO stock_movimientos
            (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, pedido_item_id, motivo, usuario_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            producto.id,
            tipo,
            round2(Math.abs(delta)),
            anterior,
            nuevo,
            pedidoItemId || null,
            motivo || null,
            usuarioId || null
        ]
    );
    return { applied: true, stock_actual: nuevo, unidad: producto.unidad_stock };
}

async function descontarPorItem(connection, item, usuarioId) {
    const pedidoItemId = Number(item.id);
    const producto = await bloquearProducto(connection, item.producto_id);
    if (!Number(producto.controla_stock)) return { applied: false };
    if (await movimientoExiste(connection, pedidoItemId, 'salida_cocina')) return { applied: false };

    const delta = convertirAUnidadStock(item.cantidad, item.unidad_medida, producto.unidad_stock);
    return registrar(connection, {
        producto,
        tipo: 'salida_cocina',
        delta: -delta,
        pedidoItemId,
        motivo: 'Envío a cocina',
        usuarioId
    });
}

async function devolverPorItem(connection, item, usuarioId) {
    const pedidoItemId = Number(item.id);
    const salida = await movimientoExiste(connection, pedidoItemId, 'salida_cocina');
    if (!salida) return { applied: false };
    if (await movimientoExiste(connection, pedidoItemId, 'devolucion')) return { applied: false };

    const producto = await bloquearProducto(connection, item.producto_id);
    return registrar(connection, {
        producto,
        tipo: 'devolucion',
        delta: round2(salida.cantidad),
        pedidoItemId,
        motivo: 'Cancelación o rechazo',
        usuarioId
    });
}

async function activar(connection, { productoId, unidadStock, stockActual, stockMinimo, usuarioId }) {
    const unidad = unidadValida(unidadStock);
    if (!unidad) throw new StockError('Unidad de stock inválida', { status: 400 });
    const inicial = round2(stockActual);
    const minimo = round2(stockMinimo);
    if (!Number.isFinite(inicial) || inicial < 0) {
        throw new StockError('La existencia inicial no puede ser negativa', { status: 400 });
    }
    if (!Number.isFinite(minimo) || minimo < 0) {
        throw new StockError('El mínimo no puede ser negativo', { status: 400 });
    }

    const producto = await bloquearProducto(connection, productoId);
    const anterior = round2(producto.stock_actual);
    await connection.query(
        `UPDATE productos
         SET controla_stock = 1, unidad_stock = ?, stock_actual = ?, stock_minimo = ?
         WHERE id = ?`,
        [unidad, inicial, minimo, producto.id]
    );
    if (anterior !== inicial || !Number(producto.controla_stock)) {
        await connection.query(
            `INSERT INTO stock_movimientos
                (producto_id, tipo, cantidad, stock_anterior, stock_nuevo, motivo, usuario_id)
             VALUES (?, 'ajuste', ?, ?, ?, ?, ?)`,
            [
                producto.id,
                round2(Math.abs(inicial - anterior)),
                anterior,
                inicial,
                'Existencia inicial',
                usuarioId || null
            ]
        );
    }
    return { stock_actual: inicial, unidad_stock: unidad, stock_minimo: minimo };
}

async function desactivar(connection, productoId) {
    const producto = await bloquearProducto(connection, productoId);
    await connection.query(
        `UPDATE productos SET controla_stock = 0 WHERE id = ?`,
        [producto.id]
    );
    return { controla_stock: 0 };
}

async function entrada(connection, { productoId, cantidad, motivo, usuarioId }) {
    const producto = await bloquearProducto(connection, productoId);
    if (!Number(producto.controla_stock)) {
        throw new StockError('Este producto no tiene control de stock activo', { status: 400 });
    }
    const qty = round2(cantidad);
    if (!Number.isFinite(qty) || qty <= 0) {
        throw new StockError('La entrada debe ser mayor a 0', { status: 400 });
    }
    return registrar(connection, {
        producto,
        tipo: 'entrada',
        delta: qty,
        motivo: String(motivo || 'Entrada de inventario').trim().slice(0, 200),
        usuarioId
    });
}

async function ajuste(connection, { productoId, stockNuevo, motivo, usuarioId }) {
    const texto = String(motivo || '').trim();
    if (!texto) throw new StockError('El ajuste necesita un motivo', { status: 400 });
    const producto = await bloquearProducto(connection, productoId);
    if (!Number(producto.controla_stock)) {
        throw new StockError('Este producto no tiene control de stock activo', { status: 400 });
    }
    const destino = round2(stockNuevo);
    if (!Number.isFinite(destino) || destino < 0) {
        throw new StockError('El stock nuevo no puede ser negativo', { status: 400 });
    }
    const anterior = round2(producto.stock_actual);
    if (destino === anterior) {
        throw new StockError('El stock no cambió', { status: 400 });
    }
    return registrar(connection, {
        producto,
        tipo: 'ajuste',
        delta: round2(destino - anterior),
        motivo: texto.slice(0, 200),
        usuarioId
    });
}

module.exports = {
    StockError,
    ESTADOS_CON_STOCK,
    descontarPorItem,
    devolverPorItem,
    activar,
    desactivar,
    entrada,
    ajuste
};
