const CODIGO = 'PROPINA';

function redondear(valor) {
    const n = Number(valor);
    if (!Number.isFinite(n)) return 0;
    return Math.round((n + Number.EPSILON) * 100) / 100;
}

function calcular(base) {
    const monto = redondear(Number(base) * 0.1);
    return monto > 0 ? monto : 0;
}

function aceptada(valor) {
    return valor === true || valor === 1 || valor === '1' || valor === 'true';
}

async function obtenerId(connection) {
    const [rows] = await connection.query(
        `SELECT id FROM productos WHERE codigo = ? LIMIT 1`,
        [CODIGO]
    );
    if (!rows.length) {
        throw new Error('No está configurado el producto de propina');
    }
    return rows[0].id;
}

module.exports = { CODIGO, redondear, calcular, aceptada, obtenerId };
