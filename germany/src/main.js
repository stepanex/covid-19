const Apify = require('apify');
const SOURCE_URL = 'https://www.rki.de/DE/Content/InfAZ/N/Neuartiges_Coronavirus/Fallzahlen.html';
const LATEST = 'LATEST';
const {log} = Apify.utils;

Apify.main(async () => {
  // const { notificationEmail } = await Apify.getInput();
  const requestQueue = await Apify.openRequestQueue();
  const kvStore = await Apify.openKeyValueStore('COVID-19-GERMANY');
  const dataset = await Apify.openDataset("COVID-19-GERMANY-HISTORY");
  await requestQueue.addRequest({url: SOURCE_URL});

  // if (notificationEmail) {
  //   await Apify.addWebhook({
  //     eventTypes: ['ACTOR.RUN.FAILED', 'ACTOR.RUN.TIMED_OUT'],
  //     requestUrl: `https://api.apify.com/v2/acts/mnmkng~email-notification-webhook/runs?token=${Apify.getEnv().token}`,
  //     payloadTemplate: `{"notificationEmail": "${notificationEmail}", "eventType": {{eventType}}, "eventData": {{eventData}}, "resource": {{resource}} }`,
  //   });
  // }
  // const proxyConfiguration = await Apify.createProxyConfiguration();

  const crawler = new Apify.PuppeteerCrawler({
    requestQueue,
    // proxyConfiguration,
    gotoFunction: async ({ page, request }) => {
      return page.goto(request.url, { waitUntil: 'networkidle2', timeout: 300000 });
    },
    handlePageFunction: async ({ page, request}) => {
      await Apify.utils.puppeteer.injectJQuery(page);
      const extracted = await page.evaluate( async () => {

        const infectedByRegion = [];

        const tableRows = $('tbody > tr').toArray();
        for (let i = 0; i < tableRows.length - 1; i++) {
          const row = tableRows[i];
          const columns = $(row).find('td');
          const region = columns.eq(0).text().trim();
          const secondColumn = columns.eq(1).text().trim().replace('.','');
          const deathColumn = columns.eq(4).text().trim();
          let infectedCount = parseInt(secondColumn, 10);
          let deathCount = parseInt(deathColumn, 10);
          infectedByRegion.push({
            region,
            infectedCount,
            deceasedCount: deathCount
          });
        }

        const row = tableRows[tableRows.length - 1];
        const columns = $(row).find('td');
        const secondColumn = columns.eq(1).text().trim();
        const deathColumn = columns.eq(5).text().trim();

        return {
          secondColumn,
          deathColumn,
          infectedByRegion
        }
      })
      const { secondColumn, deathColumn, infectedByRegion } = extracted;

      const data = {
        infected: parseInt(secondColumn.replace(/\D/g, ''), 10),
        tested: undefined,
        deceased: parseInt(deathColumn.replace('.', ''), 10),
        infectedByRegion,
        country: 'Germany',
        moreData: 'https://api.apify.com/v2/key-value-stores/OHrZyNo9BzT6xKMRD/records/LATEST?disableRedirect=true',
        historyData: 'https://api.apify.com/v2/datasets/dcm4uXhiGIjVdJAzS/items?format=json&clean=1',
        SOURCE_URL,
        lastUpdatedAtApify: new Date(new Date().toUTCString()).toISOString(),
        readMe: 'https://apify.com/lukass/covid-ger',
      };

      // Compare and save to history
      const latest = await kvStore.getValue(LATEST);
      if (latest) {
        delete latest.lastUpdatedAtApify;
      }
      const actual = Object.assign({}, data);
      delete actual.lastUpdatedAtApify;
      await Apify.pushData(data);

      if (JSON.stringify(latest) !== JSON.stringify(actual)) {
        log.info('Data did change :( storing new to dataset.');
        await dataset.pushData(data);
      }

      if (latest.infected > data.infected || (latest.deceased - data.deceased) > 10) {
        log.error('Latest data are high then actual - probably wrong scrap');
        log.info('latest');
        console.log(latest);
        process.exit(1);
      }

      await kvStore.setValue(LATEST, data);
      log.info('Data stored, finished.')

    }
  });

  log.info('CRAWLER -- start');
  await crawler.run();
  log.info('CRAWLER -- finish');
});
