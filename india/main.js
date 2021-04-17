const Apify = require('apify');

const sourceUrl = 'https://www.mohfw.gov.in/';
const LATEST = 'LATEST';

Apify.main(async () => {

    const kvStore = await Apify.openKeyValueStore('COVID-19-IN');
    const dataset = await Apify.openDataset('COVID-19-IN-HISTORY');

    console.log('Launching Puppeteer...');
    const browser = await Apify.launchPuppeteer();

    const page = await browser.newPage();
    await Apify.utils.puppeteer.injectJQuery(page);

    console.log('Going to the website...');
    await page.goto(sourceUrl, { waitUntil: 'networkidle0', timeout: 600000 });

    console.log('Getting data...');

    const result = await page.evaluate(() => {
        const now = new Date();

        const activeCases = Number($('strong:contains(Active)').next().text().split("(")[0]);
        const activeCasesNew = Number($('strong:contains(Active)').next().text().split("(")[1].replace(/\D/g, ''));
        const recovered = Number($('strong:contains(Discharged)').next().text().split("(")[0]);
        const recoveredNew = Number($('strong:contains(Discharged)').next().text().split("(")[1].replace(/\D/g, ''));
        const deaths = Number($('strong:contains(Deaths)').next().text().split("(")[0]);
        const deathsNew = Number($('strong:contains(Deaths)').next().text().split("(")[1].replace(/\D/g, ''));
        const previousDayTests = Number($('.header-section > div > div > div > div > div > marquee > span').text().split(" ")[9].split(",").join(""));

        const rawTableRows = [...document.querySelectorAll("#state-data > div > div > div > div > table > tbody > tr")];
        const regionsTableRows = rawTableRows.filter(row => row.querySelectorAll('td').length === 8);
        const regionData = [];

        for (const row of regionsTableRows) {
            const cells = Array.from(row.querySelectorAll("td")).map(td => getFormattedNumber(td));
            if (cells[1] !== 'Total#') regionData.push({
                region: cells[1],
                totalInfected: Number(cells[2]),
                newInfected: Number(cells[3]),
                recovered: Number(cells[4]),
                newRecovered: Number(cells[5]),
                deceased: Number(cells[6]),
                newDeceased: Number(cells[7])
            });
        }

        function getFormattedNumber(td) {
            const tdText = $(td).text().trim();
            if ($(td).find('.fa-arrow-up').length) return Number(`+${tdText}`);
            if ($(td).find('.fa-arrow-down').length) return Number(`-${tdText}`);
            return isNaN(tdText) ? tdText : Number(tdText);
        }

        const data = {
            activeCases,
            activeCasesNew,
            recovered,
            recoveredNew,
            deaths,
            deathsNew,
            previousDayTests,
            totalCases: activeCases + recovered + deaths,
            sourceUrl: 'https://www.mohfw.gov.in/',
            lastUpdatedAtApify: new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes())).toISOString(),
            readMe: 'https://github.com/zpelechova/covid-in/blob/master/README.md',
            regionData: regionData,
        };
        return data;

    });

    console.log(result)

    let latest = await kvStore.getValue(LATEST);
    if (!latest) {
        await kvStore.setValue('LATEST', result);
        latest = result;
    }
    delete latest.lastUpdatedAtApify;
    const actual = Object.assign({}, result);
    delete actual.lastUpdatedAtApify;

    if (JSON.stringify(latest) !== JSON.stringify(actual)) {
        await dataset.pushData(result);
    }

    await kvStore.setValue('LATEST', result);
    await Apify.pushData(result);

    console.log('Closing Puppeteer...');
    await browser.close();
    console.log('Done.');
});
