const d = require('./getdata_pre_arquivo.json');

function calcularSaldoReplay(nrSerie, codItem, operacao) {
  const eventos = [];
  d.forEach(r => {
    if (r['TIPO DE APONTAMENTO'] !== 'FECHAMENTO') return;
    const serieLinha = String(r['Nº SÉRIE | IMPLEMENTO | CLIENTE | INTERNO']||'').split('|')[0].trim();
    const itemLinha = String(r['CÓDIGO DO ITEM']||'').trim();
    const opLinha = String(r['TIPO DE OPERAÇÃO 1']||'').substring(0,4);
    if (serieLinha !== nrSerie || itemLinha !== codItem || opLinha !== operacao) return;
    eventos.push({
      qtdPlanejada: Number(r['QTD PLANEJADA']) || 0,
      qtdRealizada: Number(r['QUANTIDADE']) || 0,
      carimbo: r['Carimbo de data/hora'],
    });
  });
  let saldo = null;
  eventos.forEach(ev => {
    if (saldo === null || saldo <= 0) saldo = Math.max(0, ev.qtdPlanejada - ev.qtdRealizada);
    else saldo = Math.max(0, saldo - ev.qtdRealizada);
  });
  return { saldo, totalEventos: eventos.length };
}

const chaves = [
  ['22000073', 'ELET - 157 - 000', '0070'],
  ['PRODUÇÃO', 'TREINAMENTO', '0102'],
  ['22000073', '401113', '0070'],
];

chaves.forEach(([nrSerie, codItem, operacao]) => {
  const r = calcularSaldoReplay(nrSerie, codItem, operacao);
  console.log(nrSerie, '|', codItem, '|', operacao, '-> saldo esperado:', r.saldo, '(', r.totalEventos, 'fechamentos)');
});
