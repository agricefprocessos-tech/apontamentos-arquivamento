const API = 'https://script.google.com/macros/s/AKfycbzqXA7fg1-IEQbbp4Zggwy9FMzAXaUOfEbjpppZslJLu9f0TbiMelaOroHTe7qYencItw/exec';
function rid(p) { return p + '_' + Date.now() + '_' + Math.floor(Math.random()*100000); }
function nowParts() {
  const d = new Date();
  const pad = n => String(n).padStart(2,'0');
  return { ts: pad(d.getDate())+'/'+pad(d.getMonth()+1)+'/'+d.getFullYear()+' '+pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds()), hora: pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds()) };
}
async function post(payload) {
  const res = await fetch(API, { method: 'POST', redirect: 'follow', body: JSON.stringify(payload) });
  return JSON.parse(await res.text());
}
async function get(qs) {
  const res = await fetch(API + '?' + qs + '&_=' + Date.now(), { redirect: 'follow' });
  return JSON.parse(await res.text());
}

const OP = '999888';
const NOME = '999888 - TESTE ADMIN ARQUIVADO (remover)';

async function main() {
  let ts, hora, r;
  console.log('=== 1. ABERTURA teste ===');
  ({ ts, hora } = nowParts());
  r = await post({
    requestId: rid('adm-abre'), timestamp: ts, hora, operador: OP, operadorNome: NOME,
    nrSerie: '22000073', implemento: 'HAULER 10"', cliente: 'SÃO MARTINHO',
    tipoApontamento: 'ABERTURA', operacao: '0010 - CORTAR', codItem: '999999TESTEHIST',
    quantidade: null, qtdPlanejada: '5', obs1: '', retrabalho: '', numRNC: '', parada: '', setup: '', obs2: '',
    isLote: false, lote: '', loteSeries: null, abertoId: '',
  });
  console.log(JSON.stringify(r));
  const abertoId = r.abertoId;

  await new Promise(res => setTimeout(res, 1200));

  console.log('=== 2. FECHAMENTO teste ===');
  ({ ts, hora } = nowParts());
  r = await post({
    requestId: rid('adm-fecha'), timestamp: ts, hora, operador: OP, operadorNome: NOME,
    nrSerie: '22000073', implemento: 'HAULER 10"', cliente: 'SÃO MARTINHO',
    tipoApontamento: 'FECHAMENTO', operacao: '0010 - CORTAR', codItem: '999999TESTEHIST',
    quantidade: 5, qtdPlanejada: '5', obs1: '', retrabalho: '', numRNC: '', parada: '', setup: '', obs2: '',
    isLote: false, lote: '', loteSeries: null, abertoId: abertoId,
  });
  console.log(JSON.stringify(r));

  console.log('=== 3. Preview arquivamento margem=0 (deve pegar este registro) ===');
  r = await get('action=previewArquivamento&key=AGF2026&margemDias=0');
  console.log('elegiveis:', r.abertoIdsElegiveis, 'linhas:', r.linhasElegiveis);

  console.log('=== 4. Executa arquivamento margem=0 ===');
  r = await get('action=executarArquivamento&key=AGF2026&margemDias=0');
  console.log(JSON.stringify(r));

  console.log('=== 5. Confirma que sumiu do getData (aba viva) ===');
  const dados = await get('action=getData');
  const aindaNaViva = dados.filter(x => x['CÓDIGO DO ITEM'] === '999999TESTEHIST');
  console.log('linhas ainda na aba viva:', aindaNaViva.length, '(esperado: 0)');

  console.log('=== 6. abertoId de teste:', abertoId, '===');
  console.log('SALVE ESTE abertoId PRA PRÓXIMA ETAPA');
}
main();
