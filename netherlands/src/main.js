const Apify = require('apify');
const SOURCE_URL = 'https://www.rivm.nl/en/novel-coronavirus-covid-19/current-information';
const LATEST = 'LATEST';
const { load } = require('cheerio');
const {log, requestAsBrowser} = Apify.utils;

const LABELS = {
    GOV: 'GOV',
    GIS: 'GIS',
    GIS_REGIONS: 'GIS_REGIONS'
};

Apify.main(async () => {
    const { notificationEmail, doErrorCheck = true, failedLimit = 5 } = await Apify.getInput();
    const requestQueue = await Apify.openRequestQueue();
    const kvStoreFailed = await Apify.openKeyValueStore('COVID-19-NL-FAILED');
    let failedBefore = (await kvStoreFailed.getValue('FAILED')) || 0;
    const kvStore = await Apify.openKeyValueStore('COVID-19-NL');
    const dataset = await Apify.openDataset("COVID-19-NL-HISTORY");
    await requestQueue.addRequest({ url: 'https://coronadashboard.government.nl/landelijk/positief-geteste-mensen', userData: { label: LABELS.GOV }})
    await requestQueue.addRequest({ url: 'https://services9.arcgis.com/N9p5hsImWXAccRNI/arcgis/rest/services/Nc2JKvYFoAEOFCG5JSI6/FeatureServer/3/query?f=json&where=Country_Region%3D%27Netherlands%27&returnGeometry=false&spatialRel=esriSpatialRelIntersects&outFields=*&orderByFields=Confirmed%20desc&outSR=102100&resultOffset=0&resultRecordCount=75&resultType=standard&cacheHint=true',
        headers: {
            referer: 'https://gisanddata.maps.arcgis.com/apps/opsdashboard/index.html'
        },
        userData: {label: LABELS.GIS_REGIONS}})
    await requestQueue.addRequest({ url: 'https://services9.arcgis.com/N9p5hsImWXAccRNI/arcgis/rest/services/Nc2JKvYFoAEOFCG5JSI6/FeatureServer/2/query?f=json&where=Recovered%3C%3E0&returnGeometry=false&spatialRel=esriSpatialRelIntersects&outFields=*&orderByFields=Recovered%20desc&resultOffset=0&resultRecordCount=250&resultType=standard&cacheHint=true',
        headers: {
            referer: 'https://gisanddata.maps.arcgis.com/apps/opsdashboard/index.html'
        },
        userData: { label: LABELS.GIS }});

    if (notificationEmail && failedLimit < failedBefore) {
        await Apify.addWebhook({
            eventTypes: ['ACTOR.RUN.FAILED', 'ACTOR.RUN.TIMED_OUT'],
            requestUrl: `https://api.apify.com/v2/acts/mnmkng~email-notification-webhook/runs?token=${Apify.getEnv().token}`,
            payloadTemplate: `{"notificationEmail": "${notificationEmail}", "eventType": {{eventType}}, "eventData": {{eventData}}, "resource": {{resource}} }`,
        });
    }

    let totalInfected = 0;
    let totalDeceased = undefined;
    let totalRecovered = undefined;
    let dailyInfected = undefined;
    let dailyDeceased = undefined;
    let reproductionNumber = undefined;
    let infectedByRegion = [];
    const proxyConfiguration = await Apify.createProxyConfiguration();

    const crawler = new Apify.BasicCrawler({
        requestQueue,
        maxRequestRetries: 2,
        handleRequestTimeoutSecs: 120,
        handleRequestFunction: async ({ request}) => {
            const { label } = request.userData;
            let response = await requestAsBrowser({
                  url: request.url,
                  headers: request.headers || {},
                  proxyUrl: proxyConfiguration.newUrl(),
              });
            switch (label) {
                case LABELS.GIS:
                    if (response.statusCode === 200) {
                        const body = JSON.parse(response.body);
                        const attributes = body.features.filter(f => f.attributes.Country_Region === 'Netherlands').map(d => d.attributes)[0];
                        totalInfected = attributes.Confirmed;
                        totalDeceased = attributes.Deaths;
                        totalRecovered = attributes.Recovered;
                    }
                    break;
                case LABELS.GIS_REGIONS:
                    if (response.statusCode === 200) {
                        const body = JSON.parse(response.body);
                        for (const province of body.features) {
                            const {attributes} = province;
                            infectedByRegion.push({
                                region: attributes.Province_State,
                                infectedCount: attributes.Confirmed,
                                deceasedCount: attributes.Deaths
                            });
                        }
                    }
                    break;
                case LABELS.GOV:
                    if (response.statusCode === 200) {
                        const $ = load(response.body);
                        const text = $('#__NEXT_DATA__').map((i, el) => $(el).html()).get()
                          .toString()
                          .trim();
                        const { props } = JSON.parse(text);
                        dailyInfected = props.pageProps.data.infected_people_total.last_value.infected_daily_total;
                        dailyDeceased = props.pageProps.data.deceased_rivm.last_value.covid_daily;
                        reproductionNumber = props.pageProps.data.reproduction_index_last_known_average.last_value.reproduction_index_avg;
                    }
                    break;
            }

        },
        handleFailedRequestFunction: async ({request}) => {
            console.log(`Request ${request.url} failed twice.`);
        },
    });

    log.info('CRAWLER -- start');
    await crawler.run();
    log.info('CRAWLER -- finish');

    const data = {
        infected: parseInt(totalInfected, 10),
        tested: undefined,
        recovered: parseInt(totalRecovered, 10),
        deceased: parseInt(totalDeceased, 10),
        dailyInfected,
        reproductionNumber,
        infectedByRegion,
        country: 'Netherlands',
        moreData: 'https://api.apify.com/v2/key-value-stores/vqnEUe7VtKNMqGqFF/records/LATEST?disableRedirect=true',
        historyData: 'https://api.apify.com/v2/datasets/jr5ogVGnyfMZJwpnB/items?format=json&clean=1',
        SOURCE_URL,
        lastUpdatedAtApify: new Date(new Date().toUTCString()).toISOString(),
        readMe: 'https://apify.com/lukass/covid-nl',
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

    if (doErrorCheck && ((latest.infected - 10) > actual.infected || (latest.deceased - 10) > actual.deceased)) {
        failedBefore = failedBefore + 1;
        await kvStoreFailed.setValue('FAILED', failedBefore);
        log.error('Actual numbers are lower then latest probably wrong parsing');
        process.exit(1);
    }

    await kvStore.setValue(LATEST, data);
    await Apify.setValue('COVID-19-NL-FAILED', 0);
    log.info('Data stored, finished.');
});
