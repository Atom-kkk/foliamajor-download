import React from 'react';
import { ChevronRight, CircleHelp, ExternalLink, Lightbulb, Mail, Sparkles, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { openPonderNavigation } from '../../../../services/ponder/pagePonderTarget';
import { BUILD_KIND_TAGS, getBuildKind } from '../../../../utils/buildProvenance';
import { PRIMARY_MODIFIER_LABEL } from '../../../../utils/platform';
import { HELP_TAB_PLAYER_CONTROLS, HELP_TAB_PRIMARY_SHORTCUTS } from '../../userGuideContent';
import { Button, CopyButton, CopyValue, Group, Keys, Row, type SettingsGroupDef } from '../kit';
import { openOutsideLink } from '../../../../utils/system/outsideLink';
import { FoundUpdateRow } from './FoundUpdateRow';
import { ChinaDrivesRow } from './ChinaDrivesRow';
import { iconLabel } from './iconLabel';

// src/components/modal/settings/pages/HelpPage.tsx
// The 帮助 page, reached from the foot of the side list: two entry cards (the release notes, the
// Ponder tutorials), the keyboard shortcuts and the player's keys side by side, where to get help
// (the help dialog, the maintainer's address), and the version with a found update and the
// project link. A build that is not this repository's own says so under its version. It is not a settings category, so it
// is not in pages/index.ts and the search does not list it; the settings window mounts it itself
// and hands it the two dialogs it opens.
//
// This is a fork: the project row points at this build's repository, and the upstream author's
// project is credited at the foot of the page, one size smaller.

const REPOSITORY_URL = 'https://github.com/Atom-kkk/foliamajor-download';
const REPOSITORY_NAME = 'Atom-kkk/foliamajor-download';
/** The maintainer's address, the only way to reach this build's author. */
const CONTACT_EMAIL = '517298997@qq.com';
/** Where the code this build started from lives. Credited at the foot, in smaller type. */
const UPSTREAM_URL = 'https://github.com/chthollyphile/folia-major';
const UPSTREAM_NAME = 'chthollyphile/folia-major';
const BUILD_KIND = getBuildKind();
// 这一行会被贴进问题报告，所以留着提交号；分支名去掉了——那是上游的分支（`update/upstream-0.7.28`），
// 对看这个数字的人没有意义。
const VERSION_INFO = (__DOCKER_STACK_VERSION__
    ? `${__APP_VERSION_LABEL__} v${__APP_VERSION__} · Stack ${__DOCKER_STACK_VERSION__} · ${__COMMIT_HASH__}`
    : `${__APP_VERSION_LABEL__} v${__APP_VERSION__} · ${__COMMIT_HASH__}`)
    // Self-hosted and unofficial builds always carry a tag, in English, so a line pasted into an
    // issue says where the build came from.
    + (BUILD_KIND === 'official' ? '' : ` · ${BUILD_KIND_TAGS[BUILD_KIND]}`);

const SHORTCUTS: SettingsGroupDef = { id: 'helpShortcuts', titleKey: 'help.keyboardShortcuts' };
const PLAYER_KEYS: SettingsGroupDef = { id: 'helpPlayerControls', titleKey: 'help.playerControls' };
const SUPPORT: SettingsGroupDef = { id: 'helpSupport', titleKey: 'aiHelp.title' };
const ABOUT: SettingsGroupDef = { id: 'helpAbout', titleKey: 'help.version' };

/** Two columns that become one where a column would be narrower than 280px. */
const COLUMNS_CLASS = 'grid grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-x-3';

type TileProps = {
    testId: string;
    icon: LucideIcon;
    title: string;
    line: string;
    onClick: () => void;
};

/** An entry card: an icon, a title, one line, and an arrow. The whole card opens what it names. */
const Tile: React.FC<TileProps> = ({ testId, icon: Icon, title, line, onClick }) => (
    <button
        type="button"
        data-testid={testId}
        onClick={onClick}
        className="group st-t-fast flex min-h-[72px] items-center gap-3.5 rounded-xl bg-[var(--st-card)] px-4 py-3.5 text-left shadow-[0_0_0_1px_var(--st-line)] transition-colors hover:bg-[color-mix(in_srgb,var(--st-card)_93%,var(--st-t1))]"
    >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[10px] bg-[var(--st-fill)] text-[color:var(--st-t1)]">
            <Icon size={18} />
        </span>
        <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold leading-5 text-[color:var(--st-t1)]">{title}</span>
            <span className="mt-0.5 block text-xs leading-[18px] text-[color:var(--st-t2)]">{line}</span>
        </span>
        <ChevronRight size={16} className="st-t-fast shrink-0 text-[color:var(--st-t3)] transition-transform group-hover:translate-x-0.5" />
    </button>
);

type KeyRowProps = {
    label: string;
    /** The keys are held with the primary modifier. */
    withPrimaryModifier?: boolean;
    /** One key, or two that do a pair of things: shown with a slash between them. */
    keys: ReadonlyArray<string>;
};

/** A compact row of a card: what a shortcut does, and its key caps. */
const KeyRow: React.FC<KeyRowProps> = ({ label, withPrimaryModifier, keys }) => (
    <div className="relative flex min-h-11 items-center justify-between gap-4 px-4 py-2 text-sm leading-5 text-[color:var(--st-t1)] before:absolute before:left-4 before:right-0 before:top-0 before:h-px before:bg-[var(--st-line)] first:before:hidden">
        <span className="min-w-0">{label}</span>
        <span className="inline-flex shrink-0 items-center gap-1">
            {keys.map((key, index) => (
                <React.Fragment key={key}>
                    {index > 0 && <span aria-hidden className="text-[11px] text-[color:var(--st-t3)]">/</span>}
                    <Keys keys={withPrimaryModifier && index === 0 ? [PRIMARY_MODIFIER_LABEL, key] : [key]} />
                </React.Fragment>
            ))}
        </span>
    </div>
);

type HelpPageProps = {
    onOpenReleaseNotes: () => void;
    /** Opens the 遇到问题？ dialog. */
    onOpenAiHelp: () => void;
    /** A click on the "Project:" label; the settings window counts them. */
    onProjectLabelClick: () => void;
};

const HelpPage: React.FC<HelpPageProps> = ({ onOpenReleaseNotes, onOpenAiHelp, onProjectLabelClick }) => {
    const { t } = useTranslation();

    return (
        <>
            <div className={`${COLUMNS_CLASS} mt-5 gap-y-3`}>
                <Tile
                    testId="help-release-notes"
                    icon={Sparkles}
                    title={t('help.releaseNotes')}
                    line={t('help.releaseNotesDescription')}
                    onClick={onOpenReleaseNotes}
                />
                <Tile
                    testId="help-page-ponder"
                    icon={Lightbulb}
                    title={t('help.ponder')}
                    line={t('help.ponderDescription')}
                    onClick={openPonderNavigation}
                />
            </div>

            {/* Each group is the first in a cell of its own, so the two headings stand level; the
                cells then sit as far under the cards above as any group does. */}
            <div className={`${COLUMNS_CLASS} mt-2 gap-y-2`}>
                <div>
                    <Group def={SHORTCUTS}>
                        {HELP_TAB_PRIMARY_SHORTCUTS.map(shortcut => (
                            <KeyRow key={shortcut.id} label={t(shortcut.titleKey, shortcut.fallback)} withPrimaryModifier keys={[shortcut.key]} />
                        ))}
                    </Group>
                </div>
                <div>
                    <Group def={PLAYER_KEYS}>
                        {HELP_TAB_PLAYER_CONTROLS.map(control => (
                            <KeyRow
                                key={control.id}
                                label={control.titleKeys.map(titleKey => t(titleKey)).join(' / ')}
                                withPrimaryModifier={control.withPrimaryModifier}
                                keys={control.keys}
                            />
                        ))}
                    </Group>
                </div>
            </div>

            <Group def={SUPPORT} bare>
                <Row label={iconLabel(CircleHelp, t('aiHelp.openButton'))} onClick={onOpenAiHelp} />
                {/* An address has no link that opens it here: the row gives it to copy, like the
                    version line below does. */}
                <Row label={iconLabel(Mail, t('help.contactEmail'))}>
                    <CopyValue value={CONTACT_EMAIL} />
                </Row>
            </Group>

            <Group def={ABOUT} bare>
                <Row label={t('help.version')}>
                    {/* One piece of the row: a version too long for its line breaks inside itself and keeps the button beside it. */}
                    <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 select-text text-right font-mono text-xs text-[color:var(--st-t2)] [overflow-wrap:anywhere]">{VERSION_INFO}</span>
                        <CopyButton text={VERSION_INFO} />
                    </span>
                </Row>
                {/* 这一行原来写的是上游那句「不是官方 CI 构建、请去官方 Releases 下载」。对这里的使用者
                    没用：他们要在意的是「这个版本和原版差在哪」。所以换成一句自己的说明。 */}
                <Row sub notice={t('help.forkChanges')} />
                <FoundUpdateRow sub />
                <ChinaDrivesRow sub quiet />
                <Row
                    label={(
                        // The settings window counts the clicks and shows the cat at the seventh.
                        <button type="button" onClick={onProjectLabelClick} className="cursor-default">{t('help.madeBy')}</button>
                    )}
                >
                    <Button variant="quiet" onClick={() => openOutsideLink(REPOSITORY_URL)}>
                        {REPOSITORY_NAME}
                        <ExternalLink size={12} />
                    </Button>
                </Row>
            </Group>

            {/* The upstream author's project, at the foot and one size smaller: this build is a fork,
                and where it came from belongs on the page, just not on the same line as its own. */}
            <div className="mt-3 px-4 pb-1 text-[11px] leading-4 text-[color:var(--st-t3)]">
                {t('help.upstreamProject')}
                <button
                    type="button"
                    onClick={() => openOutsideLink(UPSTREAM_URL)}
                    className="st-t-fast ml-1 underline decoration-dotted underline-offset-2 hover:text-[color:var(--st-t1)]"
                >
                    {UPSTREAM_NAME}
                </button>
            </div>
        </>
    );
};

export default HelpPage;
