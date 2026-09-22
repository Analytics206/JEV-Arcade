"""The Classic pool: subjects the random button draws from by default.

Things most people have heard of, spread across history, places, science,
culture, sport, food and animals — so a random pair is far apart and still
winnable ("2001 World Series" to "Amazon rainforest"). Truly random articles are
the Wild pool (`wiki.Wiki.wild`), and they are mostly stubs.

Every title here is the article's exact current title: not a redirect, not a
disambiguation page. Checked against the live API on 2026-09-21; a title that
later moves still works — the draw looks each one up and follows redirects —
but it should be corrected here when noticed.
"""
from __future__ import annotations

CLASSIC: tuple[str, ...] = (
    # People
    "Abraham Lincoln", "Cleopatra", "Napoleon", "Genghis Khan", "Joan of Arc",
    "Julius Caesar", "Winston Churchill", "Mahatma Gandhi", "Nelson Mandela",
    "Queen Victoria", "Martin Luther King Jr.", "Albert Einstein", "Marie Curie",
    "Isaac Newton", "Leonardo da Vinci", "William Shakespeare", "Charles Darwin",
    "Ada Lovelace", "Nikola Tesla", "Frida Kahlo", "Wolfgang Amadeus Mozart",
    "Ludwig van Beethoven", "Harriet Tubman", "Galileo Galilei", "Confucius",
    "Alexander the Great", "Elvis Presley", "Michael Jackson", "Pablo Picasso",
    "Vincent van Gogh", "Michael Jordan", "Serena Williams", "Muhammad Ali",
    "Babe Ruth", "Pelé", "Usain Bolt", "Amelia Earhart", "Walt Disney",
    # Events
    "World War I", "World War II", "French Revolution", "Fall of the Berlin Wall",
    "Apollo 11", "Chernobyl disaster", "Sinking of the Titanic", "Black Death",
    "Great Fire of London", "Boston Tea Party", "Battle of Hastings",
    "Cuban Missile Crisis", "Wall Street crash of 1929", "September 11 attacks",
    "2001 World Series", "1966 FIFA World Cup", "Super Bowl I", "Miracle on Ice",
    "2008 financial crisis", "Watergate scandal", "Renaissance",
    "Industrial Revolution", "Space Race", "Woodstock", "Moon landing",
    "American Civil War", "Gold rush",
    # Places and structures
    "Amazon rainforest", "Mount Everest", "Great Wall of China", "Sahara",
    "Antarctica", "Grand Canyon", "Eiffel Tower", "Statue of Liberty",
    "Machu Picchu", "Great Barrier Reef", "Venice", "Tokyo", "Iceland",
    "Madagascar", "Mississippi River", "Yellowstone National Park", "Stonehenge",
    "Taj Mahal", "Pompeii", "Mariana Trench", "Las Vegas", "Istanbul", "Kyoto",
    "Dead Sea", "Niagara Falls", "Galápagos Islands", "Hawaii", "Siberia",
    "Mount Kilimanjaro", "Buckingham Palace", "Colosseum", "Petra",
    "Easter Island", "World Trade Center (1973–2001)", "Empire State Building",
    "Golden Gate Bridge", "Panama Canal", "International Space Station",
    "Mount Rushmore", "Hoover Dam", "Alcatraz Island", "Great Pyramid of Giza",
    "White House", "Area 51", "Bermuda Triangle", "North Pole",
    # Science and technology
    "Black hole", "Photosynthesis", "DNA", "Quantum mechanics",
    "Theory of relativity", "Periodic table", "Penicillin", "Internet",
    "World Wide Web", "Smartphone", "Artificial intelligence", "Bitcoin",
    "Printing press", "Steam engine", "Electricity", "Vaccine", "Big Bang",
    "Plate tectonics", "Volcano", "Tropical cyclone", "Solar System", "Jupiter",
    "Mars", "Moon", "Sun", "Milky Way", "Higgs boson", "Nuclear power",
    "Transistor", "Large Hadron Collider", "Hubble Space Telescope", "Dinosaur",
    "Tyrannosaurus", "Evolution", "Human brain", "Telephone", "Television",
    "Radio", "Airplane", "Car", "Computer", "Video game",
    # Culture and entertainment
    "The Beatles", "Star Wars", "Harry Potter", "Mona Lisa", "The Simpsons",
    "Pokémon", "Super Mario", "Minecraft", "Hamilton (musical)",
    "Game of Thrones", "The Lord of the Rings", "Jazz", "Hip-hop",
    "Olympic Games", "FIFA World Cup", "Tour de France", "Chess",
    "Monopoly (game)", "Lego", "Barbie", "Disneyland", "Hollywood, Los Angeles", "Opera",
    "Ballet", "Sherlock Holmes", "Batman", "Superman", "Godzilla", "King Kong",
    "Titanic (1997 film)", "The Wizard of Oz", "Jurassic Park",
    "Rock and roll", "Wimbledon Championships", "Kentucky Derby", "Stanley Cup",
    "New York Yankees", "Academy Awards", "Nobel Prize",
    # Food and everyday things
    "Pizza", "Sushi", "Chocolate", "Coffee", "Tea", "Hamburger", "Banana",
    "Potato", "Beer", "Wine", "Cheese", "Ice cream", "Bread", "Rice", "Tomato",
    "Honey", "Coca-Cola", "McDonald's", "Bicycle", "Paper", "Money", "Gold",
    "Diamond", "Umbrella",
    # Animals
    "Giant panda", "Blue whale", "Western honey bee", "Octopus", "Penguin",
    "Cat", "Dog", "Horse", "Elephant", "Shark", "Bald eagle", "Monarch butterfly",
    "Kangaroo", "Platypus", "Wolf", "Lion", "Tiger",
    # Organisations, empires and eras
    "Apple Inc.", "Google", "Ford Model T", "Boeing 747", "Roman Empire",
    "Ancient Egypt", "Vikings", "Samurai", "Piracy", "Knight", "Cowboy",
    "Ninja", "United Nations", "NASA", "Silk Road", "Stone Age",
)
