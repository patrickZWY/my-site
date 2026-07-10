{-# LANGUAGE OverloadedStrings #-}

import Hakyll
import System.FilePath (takeBaseName)

main :: IO ()
main = hakyllWith siteConfig $ do
    match "static/**" $ do
        route $ gsubRoute "static/" (const "")
        compile copyFileCompiler

    match "css/*" $ do
        route idRoute
        compile compressCssCompiler

    match "study-materials/*.md" $
        compile pandocCompiler

    match "content/*.md" $ do
        route $ customRoute pageRoute
        compile pageCompiler

    create ["private-study-assets-v1-621b0c418a9e8c8add0633a3491d19be419716893c1fa7a844a28bf51369ca71/rabbithole.html"] $ do
        route idRoute
        compile $
            makeItem ("" :: String)
                >>= loadAndApplyTemplate "templates/private-study.html" privateStudyContext
                >>= loadAndApplyTemplate "templates/default.html" privateStudyContext
                >>= relativizeUrls

    create ["sitemap.xml"] $ do
        route idRoute
        compile $ do
            pages <- filter isSitemapPage <$> loadAll "content/*.md"
            makeItem ("" :: String)
                >>= loadAndApplyTemplate "templates/sitemap.xml" (sitemapContext pages)

    match "templates/*" $ compile templateBodyCompiler

siteConfig :: Configuration
siteConfig = defaultConfiguration
    { destinationDirectory = "_site"
    , storeDirectory = "_cache"
    , tmpDirectory = "_cache/tmp"
    }

pageCompiler :: Compiler (Item String)
pageCompiler =
    pandocCompiler
        >>= loadAndApplyTemplate "templates/default.html" siteContext
        >>= relativizeUrls

siteContext :: Context String
siteContext =
    constField "siteTitle" "Zheng Wangyuan (Patrick)"
        <> constField "siteUrl" "https://zhengwangyuan-patrick.com"
        <> defaultContext

privateStudyContext :: Context String
privateStudyContext =
    constField "title" "Rabbit Hole"
        <> constField "description" "Private architecture-agent guide and study materials."
        <> constField "canonicalPath" "/rabbithole/"
        <> constField "bodyClass" "private-study"
        <> field "guideBody" (\_ -> itemBody <$> load (fromFilePath "study-materials/agent.md"))
        <> field "luaStudyPlanBody" (\_ -> itemBody <$> load (fromFilePath "study-materials/lua-study-plan.md"))
        <> listField "studyEntries" studyEntryContext (mapM load studyMaterialIds)
        <> listField "compilerStudyEntries" studyEntryContext (mapM load compilerStudyIds)
        <> siteContext

studyEntryContext :: Context String
studyEntryContext =
    field "studyId" (return . studyIdFor . itemIdentifier)
        <> field "studyNavTitle" (return . studyNavTitleFor . itemIdentifier)
        <> field "studyTag" (studyTagField . itemIdentifier)
        <> siteContext

studyMaterialIds :: [Identifier]
studyMaterialIds =
    map
        fromFilePath
        [ "study-materials/study-linux-core.md"
        , "study-materials/study-openssh-portable.md"
        , "study-materials/study-openvpn.md"
        , "study-materials/study-glibc-threading.md"
        , "study-materials/study-opendal.md"
        , "study-materials/study-oprofile.md"
        , "study-materials/bentoml-study.md"
        , "study-materials/pony-study.md"
        ]

compilerStudyIds :: [Identifier]
compilerStudyIds =
    map
        fromFilePath
        [ "study-materials/study-lua.md"
        , "study-materials/study-ryujit.md"
        ]

studyIdFor :: Identifier -> String
studyIdFor =
    ("source-" <>) . takeBaseName . toFilePath

studyNavTitleFor :: Identifier -> String
studyNavTitleFor identifier =
    case takeBaseName (toFilePath identifier) of
        "study-linux-core" -> "Linux Kernel"
        "study-openssh-portable" -> "OpenSSH"
        "study-openvpn" -> "OpenVPN"
        "study-glibc-threading" -> "glibc NPTL"
        "study-opendal" -> "OpenDAL"
        "study-oprofile" -> "OProfile"
        "bentoml-study" -> "BentoML"
        "pony-study" -> "Pony ORM"
        "study-lua" -> "Lua"
        "study-ryujit" -> "RyuJIT"
        baseName -> baseName

studyTagField :: Identifier -> Compiler String
studyTagField identifier = do
    tags <- getMetadataField identifier "tags"
    case tags of
        Just value -> return value
        Nothing -> noResult "No study tags"

sitemapContext :: [Item String] -> Context String
sitemapContext pages =
    listField "entries" siteContext (return pages)
        <> siteContext

pageRoute :: Identifier -> FilePath
pageRoute identifier =
    case takeBaseName (toFilePath identifier) of
        "index" -> "index.html"
        "404" -> "404.html"
        page -> page <> "/index.html"

isSitemapPage :: Item String -> Bool
isSitemapPage =
    (/= "404") . takeBaseName . toFilePath . itemIdentifier
