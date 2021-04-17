const Apify = require('apify')

const { log } = Apify.utils
const LATEST = 'LATEST'
const now = new Date()

const sourceUrl = 'https://www.gov.pl/web/koronawirus/wykaz-zarazen-koronawirusem-sars-cov-2';
const detailsDataUrl = 'https://rcb-gis.maps.arcgis.com/apps/opsdashboard/index.html#/e496f00bd8b947099ff95d9e26418a2c'
const regionDataUrl = 'https://rcb-gis.maps.arcgis.com/apps/opsdashboard/index.html#/a0dd36f27d8c4fd895f4c1c78a6757f0'

Apify.main(async () => {

    const kvStore = await Apify.openKeyValueStore('COVID-19-POLAND');
    const dataset = await Apify.openDataset('COVID-19-POLAND-HISTORY');

    const requestList = new Apify.RequestList({ sources: [{ url: detailsDataUrl }] })
    await requestList.initialize()

    let criticalErrors = 0

    const crawler = new Apify.PuppeteerCrawler({
        requestList,
        useApifyProxy: true,
        // apifyProxyGroups: ['CZECH_LUMINATI'],
        puppeteerPoolOptions: {
            retireInstanceAfterRequestCount: 1
        },
        handlePageTimeoutSecs: 120,
        launchPuppeteerFunction: () => {
            const options = {
                useApifyProxy: true,
                // useChrome: true
            }
            return Apify.launchPuppeteer(options)
        },
        gotoFunction: async ({ page, request }) => {
            await Apify.utils.puppeteer.blockRequests(page, {
                urlPatterns: [
                    ".jpg",
                    ".jpeg",
                    ".png",
                    ".svg",
                    ".gif",
                    ".woff",
                    ".pdf",
                    ".zip",
                    ".pbf",
                    ".woff2",
                    ".woff",
                ],
            });
            return page.goto(request.url, { timeout: 1000 * 60 });
        },
        handlePageFunction: async ({ page, request }) => {
            log.info(`Handling ${request.url}`)

            log.info('Waiting for all data to load...')
            const allDataResponses = await Promise.all([
                page.waitForResponse(request => request.url().match(/where=1.*1.*spatialRel=esriSpatialRelIntersects.*resultRecordCount=1/g)),
                // page.waitForResponse(request => request.url().match(/where=Data.*BETWEEN.*(.*).*AND.*CURRENT_TIMESTAMP.*spatialRel=esriSpatialRelIntersects.*resultRecordCount=1/g)),
            ]);
            log.info('Content loaded, Processing data...')

            const { features: firstPart } = await allDataResponses[0].json();
            // const { features: secondPart } = await allDataResponses[1].json();

            const dailyRecovered = firstPart[0].attributes.LICZBA_OZDROWIENCOW;
            const allData = {
                ...firstPart[0].attributes,
                // ...(secondPart[0] && secondPart[0].attributes ? secondPart[0].attributes : [])
            };

            const sourceDate = new Date(allData.Data);
            const data = {
                infected: allData.LICZBA_ZAKAZEN || "",
                deceased: allData.LICZBA_ZGONOW || "",
                recovered: allData.LICZBA_OZDROWIENCOW || "",
                activeCase: allData.AKTUALNE_ZAKAZENIA || "",
                dailyInfected: allData.ZAKAZENIA_DZIENNE || "",
                dailyTested: allData.TESTY || "",
                dailyPositiveTests: allData.TESTY_POZYTYWNE || "",
                dailyDeceased: allData.ZGONY_DZIENNE || "",
                dailyDeceasedDueToCovid: allData.ZGONY_COVID || "",
                dailyRecovered,
                dailyQuarantine: allData.KWARANTANNA,
                lastUpdatedAtApify: new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes())).toISOString(),
                lastUpdatedAtSource: new Date(Date.UTC(sourceDate.getFullYear(), sourceDate.getMonth(), sourceDate.getDate(), sourceDate.getHours(), sourceDate.getMinutes())).toISOString(),
                country: 'Poland',
                sourceUrl,
                historyData: 'https://api.apify.com/v2/datasets/L3VCmhMeX0KUQeJto/items?format=json&clean=1',
                readMe: 'https://apify.com/vaclavrut/covid-pl',
            };

            // Extract region data
            await page.goto(regionDataUrl, { timeout: 1000 * 60 });

            log.info('Waiting for region data to load...');
            const regionResponse = await Promise.all([
                page.waitForResponse(request => request.url().match(/where=1.*1.*spatialRel=esriSpatialRelIntersects.*resultRecordCount=25/g)),
            ]);
            log.info('Content loaded, Processing and saving data...')

            const { features: regionData } = await regionResponse[0].json();
            const infectedByRegion = regionData.map(({ attributes: {
                jpt_nazwa_, SUM_Confirmed, SUM_Deaths, KWARANTANNA, TESTY, TESTY_POZYTYWNE, TESTY_NEGATYWNE, SUM_Recovered
            } }) => {
                return {
                    region: jpt_nazwa_,
                    infectedCount: SUM_Confirmed,
                    recoveredCount: SUM_Recovered,
                    deceasedCount: SUM_Deaths,
                    testedCount: TESTY,
                    quarantineCount: KWARANTANNA,
                    testedPositive: TESTY_POZYTYWNE,
                    testedNegative: TESTY_NEGATYWNE,
                }
            });
            data.infectedByRegion = infectedByRegion;
            // In case infected and deceased not found, calculte it from region data
            if (!data.infected) {
                data.infected = data.infectedByRegion.map(({ infectedCount }) => infectedCount)
                    .reduce((prev, cur) => {
                        return prev + cur;
                    }, 0);
            }
            if (!data.deceased) {
                data.deceased = data.infectedByRegion.map(({ deceasedCount }) => deceasedCount)
                    .reduce((prev, cur) => {
                        return prev + cur;
                    }, 0);
            }

            // Push the data
            let latest = await kvStore.getValue(LATEST)
            if (!latest) {
                await kvStore.setValue('LATEST', data)
                latest = Object.assign({}, data)
            }
            delete latest.lastUpdatedAtApify
            const actual = Object.assign({}, data)
            delete actual.lastUpdatedAtApify

            const { itemCount } = await dataset.getInfo()
            if (
                JSON.stringify(latest) !== JSON.stringify(actual) ||
                itemCount === 0
            ) {
                await dataset.pushData(data)
            }

            await kvStore.setValue('LATEST', data)
            await Apify.pushData(data)

            log.info('Data saved.')
        },
        handleFailedRequestFunction: ({ requst, error }) => {
            criticalErrors++
        }
    })
    await crawler.run()
    log.info('Done.')
})