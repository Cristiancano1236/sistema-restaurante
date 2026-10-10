(function () {
    const tabla = document.getElementById('tablaStock');
    const vacio = document.getElementById('stockVacio');
    const buscar = document.getElementById('buscarStock');
    const modal = new bootstrap.Modal(document.getElementById('modalStock'));
    let filtro = 'todos';
    let productos = [];
    let seleccionado = null;
    let timer = null;

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function numero(value) {
        return Number(value || 0).toLocaleString('es-CO', { maximumFractionDigits: 2 });
    }

    function estadoDe(p) {
        if (!Number(p.controla_stock)) return 'off';
        const actual = Number(p.stock_actual || 0);
        const minimo = Number(p.stock_minimo || 0);
        if (actual <= 0) return 'out';
        if (actual <= minimo) return 'warn';
        return 'ok';
    }

    function etiqueta(estado) {
        if (estado === 'off') return { texto: 'Sin control', clase: 'text-bg-secondary' };
        if (estado === 'out') return { texto: 'Agotado', clase: 'text-bg-danger' };
        if (estado === 'warn') return { texto: 'Bajo', clase: 'text-bg-warning' };
        return { texto: 'Disponible', clase: 'text-bg-success' };
    }

    function pintar(lista) {
        tabla.innerHTML = lista.map((p) => {
            const estado = etiqueta(estadoDe(p));
            const existencia = Number(p.controla_stock)
                ? `${numero(p.stock_actual)} ${escapeHtml(p.unidad_stock || 'UND')}`
                : '—';
            return `
                <tr>
                    <td>${escapeHtml(p.codigo)}</td>
                    <td>${escapeHtml(p.nombre)}</td>
                    <td class="text-end">${existencia}</td>
                    <td class="text-end">${Number(p.controla_stock) ? numero(p.stock_minimo) : '—'}</td>
                    <td><span class="badge ${estado.clase}">${estado.texto}</span></td>
                    <td class="text-center">
                        <button type="button" class="btn btn-sm ${Number(p.controla_stock) ? 'btn-outline-primary' : 'btn-primary'}" data-id="${p.id}">
                            ${Number(p.controla_stock) ? 'Mover' : 'Activar'}
                        </button>
                    </td>
                </tr>`;
        }).join('');
        vacio.classList.toggle('d-none', lista.length > 0);
    }

    async function cargar() {
        const params = new URLSearchParams({ q: buscar.value.trim(), filtro });
        const resp = await fetch(`/stock/api/productos?${params}`);
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'No se pudo cargar el stock');
        productos = data.productos || [];
        document.getElementById('metricControlados').textContent = numero(data.resumen?.controlados);
        document.getElementById('metricBajos').textContent = numero(data.resumen?.bajos);
        document.getElementById('metricAgotados').textContent = numero(data.resumen?.agotados);
        pintar(productos);
    }

    function abrir(producto) {
        seleccionado = producto;
        document.getElementById('modalNombre').textContent = producto.nombre;
        document.getElementById('modalCodigo').textContent = producto.codigo ? '· ' + producto.codigo : '';
        const activo = Number(producto.controla_stock) === 1;
        document.getElementById('bloqueActivar').classList.toggle('d-none', activo);
        document.getElementById('bloqueMovimientos').classList.toggle('d-none', !activo);
        document.getElementById('unidadStock').value = producto.unidad_stock || 'UND';
        document.getElementById('stockInicial').value = Number(producto.stock_actual || 0);
        document.getElementById('stockMinimo').value = Number(producto.stock_minimo || 0);
        document.getElementById('stockNuevo').value = Number(producto.stock_actual || 0);
        modal.show();
        cargarKardex(producto.id);
    }

    async function cargarKardex(productoId) {
        const lista = document.getElementById('listaKardex');
        lista.innerHTML = '<tr><td colspan="5" class="text-muted">Cargando movimientos...</td></tr>';
        const resp = await fetch(`/stock/api/movimientos?producto_id=${encodeURIComponent(productoId)}`);
        const rows = await resp.json();
        if (!resp.ok) {
            lista.innerHTML = `<tr><td colspan="5" class="text-danger">${escapeHtml(rows.error || 'No se pudo cargar el kardex')}</td></tr>`;
            return;
        }
        if (!rows.length) {
            lista.innerHTML = '<tr><td colspan="5" class="text-muted">Todavía no hay movimientos.</td></tr>';
            return;
        }
        const nombres = {
            entrada: 'Entrada',
            salida_cocina: 'Salida a cocina',
            devolucion: 'Devolución',
            ajuste: 'Ajuste'
        };
        lista.innerHTML = rows.map((m) => {
            const sube = Number(m.stock_nuevo) >= Number(m.stock_anterior);
            const fecha = new Date(m.created_at).toLocaleString('es-CO');
            const detalle = `${m.motivo || ''}${m.usuario ? (m.motivo ? ' · ' : '') + m.usuario : ''}`;
            return `
                <tr>
                    <td>${escapeHtml(fecha)}</td>
                    <td>${escapeHtml(nombres[m.tipo] || m.tipo)}</td>
                    <td class="text-end ${sube ? 'text-success' : 'text-danger'}">${sube ? '+' : '−'}${numero(m.cantidad)}</td>
                    <td class="text-end">${numero(m.stock_anterior)} → ${numero(m.stock_nuevo)}</td>
                    <td>${escapeHtml(detalle)}</td>
                </tr>`;
        }).join('');
    }

    async function post(url, body) {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {})
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) throw new Error(data.error || 'No se pudo guardar');
        return data;
    }

    async function refrescarSeleccionado() {
        await cargar();
        if (!seleccionado) return;
        const fresco = productos.find((p) => p.id === seleccionado.id);
        if (fresco) abrir(fresco);
    }

    document.getElementById('filtrosStock').addEventListener('click', (event) => {
        const boton = event.target.closest('button');
        if (!boton) return;
        filtro = boton.dataset.filtro;
        document.querySelectorAll('#filtrosStock button').forEach((el) => {
            const activo = el === boton;
            el.classList.toggle('btn-primary', activo);
            el.classList.toggle('btn-outline-secondary', !activo);
        });
        cargar().catch((err) => alert(err.message));
    });

    buscar.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => cargar().catch((err) => alert(err.message)), 200);
    });

    tabla.addEventListener('click', (event) => {
        const boton = event.target.closest('button[data-id]');
        if (!boton) return;
        const producto = productos.find((p) => String(p.id) === boton.dataset.id);
        if (producto) abrir(producto);
    });

    document.getElementById('formStock').addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!seleccionado) return;
        try {
            await post(`/stock/api/productos/${seleccionado.id}/activar`, {
                unidad_stock: document.getElementById('unidadStock').value,
                stock_actual: document.getElementById('stockInicial').value,
                stock_minimo: document.getElementById('stockMinimo').value
            });
            await refrescarSeleccionado();
        } catch (err) {
            alert(err.message);
        }
    });

    document.getElementById('btnEntrada').addEventListener('click', async () => {
        if (!seleccionado) return;
        try {
            await post(`/stock/api/productos/${seleccionado.id}/entrada`, {
                cantidad: document.getElementById('cantidadEntrada').value,
                motivo: document.getElementById('motivoEntrada').value
            });
            document.getElementById('cantidadEntrada').value = '';
            document.getElementById('motivoEntrada').value = '';
            await refrescarSeleccionado();
        } catch (err) {
            alert(err.message);
        }
    });

    document.getElementById('btnAjuste').addEventListener('click', async () => {
        if (!seleccionado) return;
        try {
            await post(`/stock/api/productos/${seleccionado.id}/ajuste`, {
                stock_nuevo: document.getElementById('stockNuevo').value,
                motivo: document.getElementById('motivoAjuste').value
            });
            document.getElementById('motivoAjuste').value = '';
            await refrescarSeleccionado();
        } catch (err) {
            alert(err.message);
        }
    });

    document.getElementById('btnDesactivar').addEventListener('click', async () => {
        if (!seleccionado) return;
        if (!confirm('¿Quitar el control de stock de este producto?')) return;
        try {
            await post(`/stock/api/productos/${seleccionado.id}/desactivar`);
            await refrescarSeleccionado();
        } catch (err) {
            alert(err.message);
        }
    });

    cargar().catch((err) => alert(err.message));
})();
