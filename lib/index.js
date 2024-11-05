const path = require('path')
const util = require('util')
const execPromise = util.promisify(require('child_process').exec)
const ncp = util.promisify(require('ncp'))
const {rimraf} = require('rimraf')
const fs = require('fs')
const readdir = util.promisify(fs.readdir)
const readFile = util.promisify(fs.readFile)
const writeFile = util.promisify(fs.writeFile)
const access = util.promisify(fs.access)
const pug = require('pug')
const tmp = require('tmp-promise')
const GitUrlParse = require('git-url-parse')
const semver = require('semver')
const debug = require('debug')('gh-pages-multi')

exports.deploy = async function ({src, target, branch, remote, template, title, dryRun, history, betterTarget}) {
    if (betterTarget) target = exports.betterTarget(target)

    debug(`deploy ${src} to ${remote}:${branch}/${target}`)

    const tmpDir = (await tmp.dir({keep: dryRun})).path

    async function exec(cmd) {
        debug(`Run command: ${cmd}`)
        const res = await execPromise(cmd, {cwd: tmpDir})
        if (res.stdout && res.stdout.length) debug('output=', res.stdout)
        return res.stdout
    }

    // Is the target branch new or already created ?
    const lsOut = await exec(`git ls-remote --heads ${remote} ${branch}`)
    const branchExists = lsOut.indexOf(`refs/heads/${branch}`) !== -1
    if (branchExists) {
        debug(`branch ${branch} exists, clone it.`)
        await exec(`git clone --single-branch -b ${branch} ${remote} ${tmpDir}`)
    } else {
        debug(`branch ${branch} doesn't exist yet, create it.`)
        // Create empty new branch
        await exec(`git clone ${remote} ${tmpDir}`)
        await exec(`git checkout --orphan ${branch}`)
        await exec('git rm -rf .')
    }

    await saveDirectory(target, src, tmpDir, history)

    const dirs = (await readdir(tmpDir)).filter(dir => dir.indexOf('.') !== 0 && dir !== 'index.html' && dir !== 'latest');
    if (isHighestNonSnapshotVersion(target, dirs)) {
        await saveAsLatest(src, tmpDir, history);
    }

    debug(`create index.html file that lists the directories in branch ${branch} from template ${template}`)

    const filteredDirs = await getFilteredDirs(tmpDir);

    const compiledTemplate = pug.compile(await readFile(template, 'utf8'))
    const fullTemplatePath = path.resolve(tmpDir, 'index.html')
    await writeFile(fullTemplatePath, compiledTemplate({filteredDirs, title}))
    debug(`written ${fullTemplatePath}`)
    const noJekyllPath = path.resolve(tmpDir, '.nojekyll')
    await writeFile(noJekyllPath, '')
    debug(`written ${noJekyllPath}`)

    // Push everything
    if (dryRun) {
        console.log('Dry run option activated, do not push anything')
    } else {
        await exec('git add -A')
        const diffOut = await exec('git diff --staged --name-only')
        if (diffOut.length === 0) return console.log('No modification to validate')
        await exec(`git commit -m "Pushed ${target} by gh-pages-multi"`)
        if (history) await exec(`git push -u origin ${branch}`)
        else await exec(`git push --force -u origin ${branch}`)
        debug(`pushed modifications to ${remote}:${branch}`)
        const gitInfo = GitUrlParse(remote)
        if (gitInfo && gitInfo.source === 'github.com') {
            console.log(`Result should be available here soon: https://${gitInfo.owner}.github.io/${gitInfo.name}/`)
        } else {
            console.log(`Directory ${src} was pushed to ${remote}:${branch}/${target}`)
        }
    }
}

exports.betterTarget = function (target) {
    const version = semver.coerce(target)
    if (version) return version.major + '.' + version.minor
    return target
}

exports.debug = async function ({src, target, branch, remote, template, title, dryRun, history, betterTarget}) {
    const filteredDirs = await getFilteredDirs("./tmp");

    const compiledTemplate = pug.compile(await readFile(template, 'utf8'))
    const fullTemplatePath = path.resolve("./tmp", 'index.html')
    await writeFile(fullTemplatePath, compiledTemplate({filteredDirs, title}))
}

async function getFilteredDirs(directory) {
    const dirs = (await readdir(directory)).filter(dir => dir.indexOf('.') !== 0 && dir !== 'index.html' && dir !== 'latest')
        .sort((a, b) => {
            const aVersion = semver.coerce(a);
            const bVersion = semver.coerce(b);

            if (aVersion && bVersion) {
                return semver.compare(aVersion, bVersion);
            }

            return a.localeCompare(b);
        });

    const officialVersions = new Set(dirs.filter(dir => !/SNAPSHOT$/.test(dir)).map(dir => semver.coerce(dir).version));
    return dirs.filter(dir => {
        const version = semver.coerce(dir).version;
        return !/SNAPSHOT$/.test(dir) || !officialVersions.has(version.replace('-SNAPSHOT', ''));
    });
}

async function saveDirectory(target, src, tmpDir, history) {
    let targetExists
    try {
        await access(path.resolve(tmpDir, target), fs.constants.F_OK)
        targetExists = true
    } catch (err) {
        debug(`${target} does not exist yet`)
        targetExists = false
    }
    if (targetExists) {
        if (!history) {
            debug(`remove all references to ${target} in git history`)
            await exec(`git filter-branch --tree-filter 'rm -rf ${target}' --prune-empty HEAD`)
        }

        debug(`remove previous directory ${target}`)
        await rimraf(path.resolve(tmpDir, target))
    }

    debug(`replace the directory ${target} with new content from ${src}`)
    await ncp(path.resolve(process.cwd(), src), path.resolve(tmpDir, target))

}

async function saveAsLatest(src, tmpDir, history) {
    await saveDirectory('latest', src, tmpDir, history);
}

function isHighestNonSnapshotVersion(target, dirs) {
    const filteredDirs = dirs.filter(dir => !/SNAPSHOT$/.test(dir));
    const sortedDirs = filteredDirs.sort((a, b) => semver.rcompare(semver.coerce(a), semver.coerce(b)));
    const highestVersion =  sortedDirs.length > 0 ? sortedDirs[0] : null;

    return highestVersion === target;
}
