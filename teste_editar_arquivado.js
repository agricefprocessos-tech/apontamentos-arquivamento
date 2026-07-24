const API = 'https://script.google.com/macros/s/AKfycbzqXA7fg1-IEQbbp4Zggwy9FMzAXaUOfEbjpppZslJLu9f0TbiMelaOroHTe7qYencItw/exec';
async function main() {
  const res = await fetch(API, {
    method: 'POST', redirect: 'follow',
    body: JSON.stringify({
      action: 'editarApontamento', key: 'AGF2026',
      abertoId: 'AP-A83065B06F', tipoAlvo: 'FECHAMENTO', nrSerieAlvo: '22000073',
      novosValores: { obs1: 'editado enquanto arquivado - teste' },
    }),
  });
  console.log(await res.text());
}
main();
